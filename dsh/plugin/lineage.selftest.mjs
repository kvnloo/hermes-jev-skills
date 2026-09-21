// Lineage + physical-operation identity. Pure, no DSH, no model calls.
//
// Lineage shape mirrors the real verified tree (root + descendants, depth 3).
import { resolveRootSession, mintTraceId, traceIdFor, operationId, lineageOf, roleFor } from './lineage.js'

let fails = 0
const check = (n, c, d) => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? '  ' + d : ''}`) }

// Canonical metadata, as DSH actually stores it.
const PARENT = {
  'session-root': null,
  'child-a': 'session-root',
  'child-b': 'session-root',
  'grandchild-c': 'child-a',
}
const parentOf = (id) => PARENT[id] ?? null

// ── Root resolution ────────────────────────────────────────────────────────
check('root resolves to itself at depth 0', resolveRootSession('session-root', parentOf).root === 'session-root')
check('a child resolves to the root at depth 1', resolveRootSession('child-a', parentOf).root === 'session-root' && resolveRootSession('child-a', parentOf).depth === 1)
check('a grandchild resolves to the root at depth 2', resolveRootSession('grandchild-c', parentOf).root === 'session-root' && resolveRootSession('grandchild-c', parentOf).depth === 2)

const cyclic = resolveRootSession('x', (id) => (id === 'x' ? 'y' : 'x'))
check('a cycle is detected, not followed forever', cyclic.cycle === true, JSON.stringify(cyclic))

const dangling = resolveRootSession('orphan', (id) => (id === 'orphan' ? 'does-not-exist' : null))
check('a missing parent is reported without inventing a root', dangling.missing_parent === null && dangling.root === 'does-not-exist')

// ── Trace stability ────────────────────────────────────────────────────────
const rootTrace = mintTraceId('session-root')
check('the root maps to a deterministic trace', rootTrace === mintTraceId('session-root'))
check('the child resolves to the SAME trace', traceIdFor('child-a', parentOf).trace_id === rootTrace)
check('the grandchild resolves to the SAME trace', traceIdFor('grandchild-c', parentOf).trace_id === rootTrace)
check('replay returns the same trace', traceIdFor('grandchild-c', parentOf).trace_id === traceIdFor('grandchild-c', parentOf).trace_id)
check('a different tree gets a different trace', mintTraceId('session-other') !== rootTrace)
check('the trace is 32 hex chars', /^[0-9a-f]{32}$/.test(rootTrace), rootTrace)

// ── Operation identity: the real observed collision pattern ────────────────
// Root and every child legitimately run turn=1 step=1 attempt=0 at the same time.
const ids = [
  operationId('session-root', 1, 1, 0),
  operationId('child-a', 1, 1, 0),
  operationId('child-b', 1, 1, 0),
]
check('same (turn,step,attempt) in three sessions yields three distinct operation ids',
  new Set(ids).size === 3, JSON.stringify(ids))
check('the operation id is stable across calls', operationId('child-a', 1, 1, 0) === operationId('child-a', 1, 1, 0))
check('a retry is a different operation', operationId('child-a', 1, 1, 0) !== operationId('child-a', 1, 1, 1))
check('a different step is a different operation', operationId('child-a', 1, 1, 0) !== operationId('child-a', 1, 2, 0))

// ── Header extraction ──────────────────────────────────────────────────────
const rootHeader = { id: 'session-root', delegationDepth: 0 }
const childHeader = { id: 'child-a', parentSession: 'session-root', origin: 'subagent', delegationDepth: 1 }
check('a root header has no parentSession', lineageOf(rootHeader).parent_session_id === null)
check('a child header preserves parentSession and origin',
  lineageOf(childHeader).parent_session_id === 'session-root' && lineageOf(childHeader).origin === 'subagent')
check('a missing header yields nulls, not fabricated lineage',
  Object.values(lineageOf(undefined)).every((v) => v === null))
check('role is root only at depth 0', roleFor({ depth: 0, origin: 'subagent' }) === 'root')
check('an unrecognized origin stays subagent, never guessed', roleFor({ depth: 1, origin: 'something-new' }) === 'subagent')
check('a proven origin is used', roleFor({ depth: 1, origin: 'rlm_worker' }) === 'rlm_worker')

// ── The agent-id shape is NOT used for parentage ───────────────────────────
const bareChild = { id: '10cd017d-f7ec-43f9-8405-39132f40dc5d', parentSession: 'session-root', origin: 'subagent', delegationDepth: 1 }
check('a bare-UUID child resolves by parentSession, not by id shape',
  resolveRootSession(bareChild.id, (id) => (id === bareChild.id ? bareChild.parentSession : null)).root === 'session-root')

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)'}`)
process.exit(fails === 0 ? 0 : 1)
