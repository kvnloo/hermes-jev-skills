// DSH-facing memory abstraction.
//
// Harness code talks only to memory.health() / search() / get(). It never sees
// SQL, connection strings or backend protocols. Backends today:
//   hermes    -- reuses the preserved read-only Hermes implementation unchanged
//   tencentdb -- existing HTTP gateway; reported unavailable when down
//
// DSH's append-only Session log remains the authoritative conversation record;
// this layer is derived/indexed memory only.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HERMES_CLI =
  process.env.JEV_DSH_HERMES_CLI || join(homedir(), '.omp/agent/extensions/hermes-memory/history.py')
const HERMES_PY = process.env.JEV_DSH_HERMES_PYTHON || 'python3'
const TDB_URL = (process.env.MEMORY_TENCENTDB_GATEWAY_URL || 'http://127.0.0.1:8420').replace(/\/$/, '')
const TDB_TIMEOUT_MS = Number(process.env.DSH_MEMORY_TDB_TIMEOUT_MS || 1500)

function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1 << 22 }, (err, stdout) => {
      if (err) return resolve({ ok: false, error: err.killed ? 'timeout' : String(err.code || err.message) })
      resolve({ ok: true, stdout })
    })
  })
}

/** Hermes backend: read-only, contract is argv JSON with {"action": ...}. */
export const hermes = {
  id: 'hermes',
  async health() {
    const r = await run(HERMES_PY, [HERMES_CLI, JSON.stringify({ action: 'status' })], 15000)
    if (!r.ok) return { backend: 'hermes', ready: false, mode: 'read-only', error: r.error }
    try {
      const d = JSON.parse(r.stdout)
      const src = d.sources?.[0] ?? {}
      return {
        backend: 'hermes',
        ready: true,
        mode: 'read-only',
        read_only: d.read_only === true,
        sources: (d.sources || []).map((s) => ({ source: s.source, sessions: s.sessions, message_rows: s.message_rows })),
        first_source: { source: src.source, path: src.path, sessions: src.sessions, message_rows: src.message_rows },
      }
    } catch (e) {
      return { backend: 'hermes', ready: false, mode: 'read-only', error: `parse:${String(e)}` }
    }
  },
  async search(query, limit = 5, filters = {}) {
    const req = { action: 'search', query, limit, store: filters.store || 'main' }
    const r = await run(HERMES_PY, [HERMES_CLI, JSON.stringify(req)], 20000)
    if (!r.ok) return { backend: 'hermes', ok: false, error: r.error, items: [] }
    try {
      const d = JSON.parse(r.stdout)
      const items = []
      for (const s of d.sources || []) {
        for (const m of s.matches || []) {
          const content = m.excerpt ?? ''
          items.push({
            id: `${s.source}:${m.message_id}`,
            backend: 'hermes',
            source: s.source,
            source_path: s.path,
            session_id: m.session_id ?? null,
            timestamp: m.timestamp ?? null,
            score: m.score ?? null,
            role: m.role ?? null,
            content,
            content_hash: createHash('sha256').update(content).digest('hex').slice(0, 16),
            provenance: { cwd: m.cwd ?? null, git_repo_root: m.git_repo_root ?? null, title: m.title ?? null },
          })
        }
      }
      return { backend: 'hermes', ok: true, read_only: true, items }
    } catch (e) {
      return { backend: 'hermes', ok: false, error: `parse:${String(e)}`, items: [] }
    }
  },
  async get(id) {
    // No per-id read path is exposed by the preserved CLI; search is the contract.
    return { backend: 'hermes', ok: false, error: 'get not exposed by the preserved read-only CLI', item: null }
  },
}

/** TencentDB backend: existing HTTP gateway. Honest-unavailable when down. */
export const tencentdb = {
  id: 'tencentdb',
  async health() {
    try {
      const ac = new AbortController()
      const t = setTimeout(() => ac.abort(), TDB_TIMEOUT_MS)
      const res = await fetch(`${TDB_URL}/health`, { signal: ac.signal })
      clearTimeout(t)
      return { backend: 'tencentdb', ready: res.ok, gateway: TDB_URL, http_status: res.status }
    } catch (e) {
      return {
        backend: 'tencentdb',
        ready: false,
        gateway: TDB_URL,
        error: e?.name === 'AbortError' ? 'timeout' : 'connection refused',
      }
    }
  },
  // Deliberately NOT implemented against a down gateway: returning fake results
  // or silently substituting Hermes would corrupt the comparison.
  async search() {
    return { backend: 'tencentdb', ok: false, error: 'gateway unavailable', items: [] }
  },
  async get() {
    return { backend: 'tencentdb', ok: false, error: 'gateway unavailable', item: null }
  },
}

const BACKENDS = [hermes, tencentdb]

export async function health() {
  const out = []
  for (const b of BACKENDS) out.push(await b.health())
  return out
}

function normalize(items) {
  return items.map((i) => ({ ...i, content: (i.content || '').replace(/\s+/g, ' ').trim() }))
}

/** Deterministic cross-store aggregation: normalize -> dedupe -> budget. */
export async function search(query, limit = 5, opts = {}) {
  const maxChars = Number(opts.maxChars || 2000)
  const perBackend = []
  const all = []
  const started = Date.now()
  for (const b of BACKENDS) {
    const t0 = Date.now()
    let r
    try {
      r = await b.search(query, limit, opts.filters || {})
    } catch (e) {
      r = { backend: b.id, ok: false, error: String(e), items: [] }
    }
    perBackend.push({ backend: b.id, ok: Boolean(r.ok), error: r.error ?? null, latency_ms: Date.now() - t0, count: (r.items || []).length })
    if (r.ok) all.push(...normalize(r.items))
  }
  // Merge in stable backend order.
  const seen = new Set()
  const merged = []
  for (const it of all) {
    const key = it.id || it.content_hash
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(it)
  }
  // Deterministic budget on characters; never hide the producing store.
  // Pass 1 admits only whole items. If the budget is too small for any whole
  // item, fall back to the top-ranked item truncated, flagged as truncated
  // rather than silently returning nothing.
  let used = 0
  const selected = []
  for (const it of merged) {
    const size = (it.content || '').length
    if (used + size > maxChars) continue
    used += size
    selected.push(it)
    if (selected.length >= limit) break
  }
  if (selected.length === 0 && merged.length > 0 && maxChars > 0) {
    const top = merged[0]
    const content = (top.content || '').slice(0, maxChars)
    selected.push({ ...top, content, truncated: true })
    used = content.length
  }
  return {
    query_chars: String(query || '').length,
    backends: perBackend,
    candidates: merged.length,
    selected: selected.length,
    injected_chars: used,
    injected_tokens_est: Math.round(used / 4),
    latency_ms: Date.now() - started,
    items: selected,
  }
}

export async function get(id) {
  for (const b of BACKENDS) {
    const r = await b.get(id)
    if (r.ok && r.item) return r
  }
  return { ok: false, item: null }
}
