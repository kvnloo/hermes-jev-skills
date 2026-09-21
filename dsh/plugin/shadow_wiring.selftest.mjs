// Integration proof for the shadow-backend wiring in index.js, without DSH.
//
//   node dsh/plugin/shadow_wiring.selftest.mjs
//
// Drives the REAL `agent/request` handler registered by apply() against a fake
// cordis ctx and a real jev decision, then asserts the observer contract:
//   1. a shadow_comparison receipt is produced for the same turn
//   2. the returned request config is NOT affected by any student
//   3. student_changed_execution is false and student values are recorded as
//      full distributions, not collapsed to a verdict
// Receipts go to a temp file; the live receipt stream is untouched.
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'shadow-wiring-'))
process.env.JEV_DSH_RECEIPTS = join(dir, 'receipts.jsonl')

const mod = await import('./index.js')

let failures = 0
const check = (name, cond, detail) => {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
}

let handler = null
const fakeCtx = {
  llm: { listProviders: () => [] },
  on: (event, fn) => {
    if (event === 'agent/request') handler = fn
  },
}
mod.apply(fakeCtx)
check('apply() registered the agent/request handler', typeof handler === 'function')

const proposed = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low', maxTokens: 256000 }
const agent = {
  id: 'session-shadowtest-0000',
  parentId: null,
  frozenMessages: [{ role: 'user', content: 'Explain how a B-tree node split works during insertion, and why the minimum degree matters.' }],
}

const t0 = Date.now()
const returned = await handler({ agent, turn: 1, step: 1 }, async () => ({ ...proposed }))
const decisionMs = Date.now() - t0

check('handler returned a config object', returned !== null && typeof returned === 'object')
check('provider was not touched by observers', returned.provider === proposed.provider, `provider=${returned.provider}`)
check('model was not touched by observers', returned.model === proposed.model, `model=${returned.model}`)
check(
  'effort came from the JEV tier, not from a student',
  ['low', 'high'].includes(returned.reasoningEffort) && returned.maxTokens === proposed.maxTokens,
  `effort=${returned.reasoningEffort} maxTokens=${returned.maxTokens} decisionMs=${decisionMs}`,
)

// Wait for the detached shadow child to land its receipt.
const deadline = Date.now() + 90_000
let recs = []
while (Date.now() < deadline) {
  recs = existsSync(process.env.JEV_DSH_RECEIPTS)
    ? readFileSync(process.env.JEV_DSH_RECEIPTS, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l)
          } catch {
            return null
          }
        })
        .filter(Boolean)
    : []
  if (recs.some((r) => r.type === 'shadow_comparison')) break
  await new Promise((r) => setTimeout(r, 500))
}

const types = recs.map((r) => r.type)
console.log(`\nreceipts: ${JSON.stringify(types)}`)
const shadow = recs.filter((r) => r.type === 'shadow_comparison')
check('a shadow_comparison receipt was produced', shadow.length > 0)
const jev = recs.find((r) => r.type === 'jev_decision')
check('a jev_decision receipt was produced for the same turn', Boolean(jev))

if (shadow.length) {
  for (const s of shadow) {
    console.log(
      `\nbackend=${s.backend} model=${s.model} success=${s.success} error=${s.error}\n` +
        `  difficulty=${s.difficulty} probs=${JSON.stringify(s.difficulty_probs)} conf=${s.confidence}\n` +
        `  specialty=${s.specialty} probs=${JSON.stringify(s.specialty_probs)} agreement=${s.specialty_agreement}\n` +
        `  costly_mistake_prob=${s.costly_mistake_prob}\n` +
        `  jev: tier=${s.jev_tier} difficulty=${s.jev_difficulty} specialty=${s.jev_specialty} conf=${s.jev_confidence}\n` +
        `  confidence_delta=${s.confidence_delta} threshold_distance_student=${s.threshold_distance_student}\n` +
        `  latency_ms=${s.latency_ms} backend_latency_ms=${s.backend_latency_ms}`,
    )
    check(`${s.backend}: declared observers-only`, s.student_changed_execution === false)
    check(`${s.backend}: tied to the same decision as JEV`, s.turn_key === (jev ? `${jev.agentId}:${jev.turn}` : null), `turn_key=${s.turn_key}`)
    check(`${s.backend}: decision_id equals turn_key for joinability`, s.decision_id === s.turn_key)
    if (s.success) {
      check(`${s.backend}: kept a full distribution, not a verdict`, s.difficulty_probs !== null && typeof s.difficulty_probs === 'object')
      check(`${s.backend}: recorded student confidence`, typeof s.confidence === 'number')
    } else {
      check(`${s.backend}: failure recorded as a receipt, not a throw`, Boolean(s.error), String(s.error))
    }
  }
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
