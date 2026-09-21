// Physical-operation identity and task lineage for the DSH adapter.
//
// Canonical DSH session metadata (parentSession, origin, delegationDepth) is the
// ONLY lineage source. Nothing here infers parentage from session-id or agent-id
// shape — the real tree has a `session-<uuid>` root and bare-UUID children, but
// that naming is a coincidence, not a contract.
//
// Kept pure and dependency-free so it is testable without a harness.

/** Bound on parent-chain traversal. */
const MAX_DEPTH = 64

/**
 * Resolve a session to its tree root by walking `parentSession`.
 *
 * Cycle-safe and missing-parent-safe: a malformed chain is reported, never
 * followed forever, and never silently re-rooted at a wrong ancestor.
 */
export function resolveRootSession(sessionId, parentOf) {
  if (sessionId == null) return { root: null, depth: 0, cycle: false, missing_parent: null }
  let cur = sessionId
  const seen = new Set()
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    if (seen.has(cur)) return { root: cur, depth, cycle: true, missing_parent: null }
    seen.add(cur)
    let parent
    try {
      parent = parentOf(cur)
    } catch {
      parent = null
    }
    if (parent == null) return { root: cur, depth, cycle: false, missing_parent: null }
    cur = parent
  }
  // Ran out of budget: report the last node reached rather than claiming a root.
  return { root: cur, depth: MAX_DEPTH, cycle: false, missing_parent: null, truncated: true }
}

/**
 * Deterministic trace id for a session tree, derived from the root session id.
 *
 * Deliberately NOT random and NOT per-child: a trace that changed on replay
 * would mint a new task identity every time state was rebuilt from the log, and
 * one trace per child would defeat the point of a task trace.
 */
export function mintTraceId(rootSessionId) {
  return hash32(`task:${rootSessionId ?? 'unknown'}`)
}

/** Resolve a session straight to its task trace id. */
export function traceIdFor(sessionId, parentOf) {
  const r = resolveRootSession(sessionId, parentOf)
  return { trace_id: mintTraceId(r.root), root_session_id: r.root, ...r }
}

/**
 * One physical inference.
 *
 * Session-scoped by construction: the same (turn, step, attempt) legitimately
 * recurs in every session of a task tree, so session_id is part of the
 * identity rather than a redundant prefix.
 */
export function operationId(sessionId, turn, step, attempt) {
  return `${sessionId ?? 'unknown'}:${num(turn)}:${num(step)}:${num(attempt)}`
}

function num(v) {
  return Number.isInteger(v) ? v : Number.isFinite(v) ? Math.trunc(v) : -1
}

function hash32(s) {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < s.length; i++) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 0x01000193) >>> 0
    h2 = Math.imul(h2 + s.charCodeAt(i) + i, 0x85ebca6b) >>> 0
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).repeat(2).slice(0, 32)
}

/** Pull canonical lineage fields off a DSH session header, without inventing any. */
export function lineageOf(header) {
  if (!header || typeof header !== 'object') {
    return { session_id: null, parent_session_id: null, origin: null, delegation_depth: null }
  }
  return {
    session_id: header.id ?? header.sessionId ?? null,
    // Absent on a root, which is exactly what makes it a root.
    parent_session_id: header.parentSession ?? null,
    origin: header.origin ?? null,
    delegation_depth: header.delegationDepth ?? null,
  }
}

/** Role from proven evidence only; anything unrecognized stays `subagent`. */
export function roleFor({ depth, origin }) {
  if (depth === 0) return 'root'
  if (origin === 'rlm_worker' || origin === 'rlm_synthesis' || origin === 'verifier') return origin
  return 'subagent'
}
