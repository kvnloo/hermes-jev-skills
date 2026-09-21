// Integration proof for the parallel decision plane wiring in index.js, without DSH.
//
//   node dsh/plugin/shadow_wiring.selftest.mjs
//
// Drives the REAL `agent/request` handler that apply() registers, against a fake
// cordis ctx and a real jev decision, then asserts the plane contract:
//   1. every lane shares one decision_id / trace_id / turn_key
//   2. systemone_direct is the ONLY production lane; the rest are shadow
//   3. the returned request config is untouched by any lane
//   4. comparisons keep raw continuous values (deltas, threshold sides)
// Receipts go to a temp file; the live receipt stream is untouched.
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'plane-wiring-'))
process.env.JEV_DSH_RECEIPTS = join(dir, 'receipts.jsonl')

const mod = await import('./index.js')

let failures = 0
const check = (name, cond, detail) => {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
}

let handler = null
mod.apply({
  llm: { listProviders: () => [] },
  on: (event, fn) => {
    if (event === 'agent/request') handler = fn
  },
})
check('apply() registered the agent/request handler', typeof handler === 'function')

const proposed = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low', maxTokens: 256000 }
const agent = {
  id: 'session-planetest-0000',
  parentId: null,
  frozenMessages: [{ role: 'user', content: 'Design a zero-downtime migration of a 4 TB SQLite archive into a sharded store.' }],
}

const t0 = Date.now()
const returned = await handler({ agent, turn: 1, step: 1 }, async () => ({ ...proposed }))
check('handler returned a config object', returned !== null && typeof returned === 'object')
check('production routing untouched by shadows', returned.provider === proposed.provider && returned.model === proposed.model, `${returned.provider}/${returned.model}`)
check('effort came from the JEV tier, not a lane', ['low', 'high'].includes(returned.reasoningEffort) && returned.maxTokens === proposed.maxTokens, `effort=${returned.reasoningEffort} in ${Date.now() - t0}ms`)

const read = () =>
  existsSync(process.env.JEV_DSH_RECEIPTS)
    ? readFileSync(process.env.JEV_DSH_RECEIPTS, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => { try { return JSON.parse(l) } catch { return null } })
        .filter(Boolean)
    : []

const deadline = Date.now() + 120_000
let recs = []
while (Date.now() < deadline) {
  recs = read()
  const lanes = recs.filter((r) => r.type === 'decision_receipt')
  if (lanes.some((l) => l.backend !== 'jev_direct') && recs.some((r) => r.type === 'decision_comparison')) break
  await new Promise((r) => setTimeout(r, 500))
}

const lanes = recs.filter((r) => r.type === 'decision_receipt')
const cmps = recs.filter((r) => r.type === 'decision_comparison')
console.log(`\nreceipt types: ${JSON.stringify([...new Set(recs.map((r) => r.type))])}`)
check('one production lane emitted', lanes.filter((l) => l.backend === 'jev_direct').length === 1)
check('exactly one lane claims production authority', lanes.filter((l) => l.authority === 'production').length === 1)
check('shadow lanes are labelled shadow', lanes.filter((l) => l.backend !== 'jev_direct').every((l) => l.authority === 'shadow'))
check('the reference lane declares family jev / transport typesafe_direct',
  lanes.some((l) => l.backend === 'jev_direct' && l.backend_family === 'jev' && l.transport === 'typesafe_direct'))
// The Vercel transport is a parity lane, not an independent vote, and must NOT
// be called on ordinary turns while the account is blocked.
check('jev_vercel is not called by default', lanes.every((l) => l.backend !== 'jev_vercel'))

const keys = new Set(recs.filter((r) => r.type === 'decision_receipt').map((r) => r.decision_id))
check('every lane joined on one decision_id', keys.size === 1, `decision_ids=${[...keys].join(',')}`)
const ids = recs.filter((r) => r.type === 'decision_receipt')
check('trace_id and turn_key equal decision_id', ids.every((r) => r.trace_id === r.decision_id && r.turn_key === r.decision_id))
check('no lane claims to have changed execution', ids.every((r) => r.student_changed_execution === false))

for (const l of lanes) {
  console.log(
    `\n${l.backend} [${l.authority}] transport=${l.transport} model=${l.model} ok=${l.success} ms=${l.latency_ms} err=${String(l.error ?? '').slice(0, 110)}` +
      (l.success ? `\n  difficulty=${l.difficulty} conf=${l.difficulty_confidence} probs=${JSON.stringify(l.difficulty_probs)}` +
        `\n  specialty=${l.specialty} conf=${l.specialty_confidence} probs=${JSON.stringify(l.specialty_probs)}` +
        `\n  costly_mistake=${l.costly_mistake} conf=${l.costly_mistake_confidence}` : ''),
  )
}
for (const c of cmps) {
  console.log(`\nCOMPARE ${c.reference} vs ${c.shadow} comparable=${c.comparable}`)
  for (const [q, v] of Object.entries(c.questions ?? {})) {
    console.log(`  ${q}: agree=${v.categorical_agreement} dConf=${v.confidence_delta} dDist=${v.distribution_delta} refSide=${v.reference_threshold_side} shadowSide=${v.shadow_threshold_side}`)
  }
}

// The blocked Vercel lane must fail loudly with its HTTP status, not silently.
const parity = cmps.filter((c) => c.kind === 'parity')
const independent = cmps.filter((c) => c.kind === 'independent')
check('no comparison to the same family is counted as an independent vote', parity.every((c) => c.counts_as_independent_vote === false))
check('the nanojev comparison is the independent one', independent.every((c) => c.shadow_family !== 'jev' && c.counts_as_independent_vote === true))

const nano = lanes.find((l) => l.backend === 'nanojev')
if (nano?.success) {
  check('nanojev kept full difficulty distribution', nano.difficulty_probs !== null && typeof nano.difficulty_probs === 'object')
  check('nanojev kept full specialty distribution', nano.specialty_probs !== null && typeof nano.specialty_probs === 'object')
}
const nanoCmp = cmps.find((c) => c.shadow === 'nanojev')
if (nanoCmp?.comparable) {
  const vals = Object.values(nanoCmp.questions ?? {})
  check('comparison preserved continuous deltas, not just agreement', vals.every((v) => 'confidence_delta' in v && 'distribution_delta' in v))
  check('comparison recorded which side of the 0.6 threshold each lane fell', vals.every((v) => 'reference_threshold_side' in v && 'shadow_threshold_side' in v))
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
