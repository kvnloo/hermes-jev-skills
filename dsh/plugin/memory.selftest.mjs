// Reproducible proof for the DSH memory abstraction.
//   node dsh/plugin/memory.selftest.mjs
// Read-only against Hermes. Writes nothing anywhere.
import { health, search, get } from './memory.js'

let failures = 0
function check(name, cond, detail) {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
}

const h = await health()
const hermes = h.find((x) => x.backend === 'hermes')
const tdb = h.find((x) => x.backend === 'tencentdb')

check('hermes backend reachable', hermes?.ready === true, JSON.stringify({ ready: hermes?.ready, error: hermes?.error }))
check('hermes reports read-only', hermes?.read_only === true)
check('hermes exposes >=1 source with counts', (hermes?.sources || []).length > 0, JSON.stringify(hermes?.sources?.[0] ?? null))
check(
  'tencentdb health is an honest boolean',
  typeof tdb?.ready === 'boolean',
  JSON.stringify({ ready: tdb?.ready, error: tdb?.error ?? null, gateway: tdb?.gateway }),
)

const r1 = await search('memory', 3, { maxChars: 2000 })
check('search returns items through the abstraction', r1.items.length > 0, `selected=${r1.selected} chars=${r1.injected_chars}`)
check('every item names its producing store', r1.items.every((i) => i.backend && i.source && i.source_path))
check('every item carries reproducibility metadata', r1.items.every((i) => i.id && i.content_hash))
check('per-backend outcomes are reported, not hidden', r1.backends.length === 2, JSON.stringify(r1.backends.map((b) => ({ b: b.backend, ok: b.ok }))))

const r2 = await search('memory', 3, { maxChars: 2000 })
check('search is deterministic for a fixed query', r1.items.map((i) => i.id).join('|') === r2.items.map((i) => i.id).join('|'))

const small = await search('memory', 3, { maxChars: 200 })
check('tight budget yields the truncated top item, not silence', small.selected === 1 && small.items[0].truncated === true, `chars=${small.injected_chars}`)
check('tight budget never exceeds the budget', small.injected_chars <= 200)

const zero = await search('', 3, { maxChars: 2000 })
check('empty query is handled without throwing', Array.isArray(zero.items), `candidates=${zero.candidates}`)

const g = await get('hermes-does-not-expose-get')
check('get fails closed when no backend serves it', g.ok === false && g.item === null)

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
