// Proves observers cannot make the user wait: with sampling off, a root turn
// still returns its production routing immediately and records why the shadow
// was skipped. No shadow backend is started.
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'sampling-'))
process.env.JEV_DSH_RECEIPTS = join(dir, 'receipts.jsonl')
process.env.JEV_DSH_SHADOW_SAMPLE_RATE = '0'

const mod = await import('./index.js')
let failures = 0
const check = (n, c, d) => { if (!c) failures++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `  ${d}` : ''}`) }

let handler = null
mod.apply({ llm: { listProviders: () => [] }, on: (e, fn) => { if (e === 'agent/request') handler = fn } })

const proposed = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low', maxTokens: 256000 }
const agent = { id: 'session-sampling-0001', parentId: null, frozenMessages: [{ role: 'user', content: 'Design a migration.' }] }

const t0 = Date.now()
const returned = await handler({ agent, turn: 1, step: 1 }, async () => ({ ...proposed }))
const elapsed = Date.now() - t0

check('production routing still returned', returned.provider === proposed.provider && returned.model === proposed.model)
check('production decision was not delayed by shadow work', elapsed < 5000, `${elapsed}ms`)
check('effort still came from the JEV tier', ['low', 'high'].includes(returned.reasoningEffort), returned.reasoningEffort)

await new Promise((r) => setTimeout(r, 500))
const recs = existsSync(process.env.JEV_DSH_RECEIPTS)
  ? readFileSync(process.env.JEV_DSH_RECEIPTS, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  : []
const skipped = recs.find((r) => r.reason === 'sampled_out')
check('the skipped shadow is recorded, not silent', Boolean(skipped), JSON.stringify(recs.map((r) => r.type)))
check('the skip states the sampling rate', skipped?.sample_rate === 0)
check('no shadow lane ran', !recs.some((r) => r.type === 'decision_comparison'))
check('no decision receipt claims to have changed execution',
  recs.filter((r) => r.type === 'decision_receipt').every((r) => r.student_changed_execution === false))

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
