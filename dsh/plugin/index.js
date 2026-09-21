// Thin DeepSeek Harness adapter for the canonical hermes-jev-skills policy.
//
// Responsibilities (and nothing else):
//   1. Run the canonical `jev route` decision ONCE per real user turn.
//   2. Map the canonical tier -> DSH reasoningEffort (harness-specific vocabulary).
//   3. Attempt model routing only when the canonical candidate resolves in DSH.
//   4. Fail open to DSH's original provider/model/effort on any problem.
//   5. Emit one compact receipt per model request (root, RLM child, synthesis).
//
// No prompt text is written to receipts. No DSH core patch is required: this uses
// the public `agent/request` waterfall and rewrites the proposed config.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import { lineageOf, operationId, roleFor, traceIdFor } from './lineage.js'
import { dirname } from 'node:path'

export const name = 'hermes-jev-dsh'
export const inject = ['llm']

const RECEIPTS = process.env.JEV_DSH_RECEIPTS || '/home/kvn/.dsh/jev/receipts.jsonl'
const JEV_ROOT = process.env.JEV_DSH_ROOT || '/home/kvn/zer0/oss/hermes-jev-skills'
const JEV_BIN = process.env.JEV_DSH_BIN || `${JEV_ROOT}/bin/jev`
const JEV_PY = process.env.JEV_DSH_PYTHON || 'python3'
const ROUTING_CONFIG =
  process.env.JEV_ROUTING_CONFIG || '/workspace/hermes-home/profiles/chiefstaff/jev/routing.json'
const KEY_FILE = process.env.JEV_DSH_KEY_FILE || '/home/kvn/.omp/.env'
const TIMEOUT_MS = Number(process.env.JEV_DSH_TIMEOUT_MS || 4000)

// Harness-specific mapping: canonical tier -> DSH effort vocabulary. Never `max`.
function effortForTier(tier) {
  return tier === 'hard' ? 'high' : 'low'
}

// ── Parallel decision plane ──────────────────────────────────────────────────
// One canonical packet per root real-user turn, fanned out concurrently.
//
// ONE backend family, TWO transports. `jev_direct` and `jev_vercel` answer the
// same semantic questions over different carriers, so they are NOT independent
// votes: their comparison is transport parity (latency, reliability,
// availability, billing, distribution parity).
//
//   jev_direct  = family jev, transport typesafe_direct    -> production authority
//   jev_vercel  = family jev, transport vercel_ai_gateway  -> parity lane, DISABLED
//   nanojev     = family nanojev, transport in_process     -> independent shadow
//
// jev_vercel is off for ordinary turns: the Vercel account returns an
// account-wide 403, so calling it per turn would cost latency for nothing. Its
// health is cached by the bridge and never re-probed per turn.
//
// Independent shadow backends are nanojev, decider_2b (opt-in), and later
// mushroom/fly. Shadows can never change provider/model/effort/RLM/tools. A
// shadow failure is recorded and ignored. No voting, no first-response-wins.
const DECISION_BACKENDS = (process.env.JEV_DSH_SHADOW_BACKENDS || 'nanojev').split(',').filter(Boolean)
// Sampling and a hard in-flight cap keep observers from making the user wait or
// contending with foreground inference. Full fanout belongs in explicit
// comparison mode, not ordinary dogfood.
const SHADOW_SAMPLE_RATE = clamp01(Number(process.env.JEV_DSH_SHADOW_SAMPLE_RATE ?? 0.1))
const SHADOW_MAX_INFLIGHT = Math.max(0, Number(process.env.JEV_DSH_SHADOW_MAX_INFLIGHT ?? 1))
let shadowInFlight = 0

function clamp01(n) {
  if (!Number.isFinite(n)) return 0.1
  return n < 0 ? 0 : n > 1 ? 1 : n
}
const LANE_PY = process.env.JEV_DSH_SHADOW_PYTHON || '/home/kvn/tmp/openjev/.venv/bin/python'
const LANE_BRIDGE = process.env.JEV_DSH_SHADOW_BRIDGE || `${JEV_ROOT}/dsh/bridge/shadow_decide.py`
const LANE_TIMEOUT_MS = Number(process.env.JEV_DSH_SHADOW_TIMEOUT_MS || 60000)

/** The production decision, expressed as the reference lane. Scalars only:
 *  the CLI route surfaces normalized values, not full distributions. */
function referenceLane(d) {
  const q = (type, value, confidence, probabilities) => ({ type, value, confidence, probabilities })
  return {
    backend: 'jev_direct',
    backend_family: 'jev',
    transport: 'typesafe_direct',
    authority: 'production',
    success: d.difficulty !== undefined,
    model: d.policy ?? 'route-2',
    revision: d.policy_version ?? null,
    latency_ms: d.latency_ms ?? null,
    answers: {
      difficulty: q('score', d.difficulty, d.confidence, null),
      kind: q('choice', d.specialty, d.confidence, null),
      // The CLI exposes only a probability here, not a confidence: carry it as a
      // distribution so the comparison gets a real distribution_delta instead of
      // mistaking a probability for a confidence.
      costly_mistake: q('boolean', d.costly_mistake != null && d.costly_mistake >= 0.5, null,
        d.costly_mistake == null ? null : { true: d.costly_mistake, false: Number((1 - d.costly_mistake).toFixed(6)) }),
    },
  }
}

/** Fire-and-forget shadow fanout. MUST NOT block or affect the turn. */
function runDecisionPlane({ prompt, turn, agentId, decision }) {
  if (!DECISION_BACKENDS.length || !prompt) return
  const turnKey = `${agentId ?? 'agent'}:${turn}`
  // Deterministic sampling per turn key, so a replay of the same turn makes the
  // same decision and the record stays reproducible.
  if (SHADOW_SAMPLE_RATE < 1 && sampleHash(turnKey) >= SHADOW_SAMPLE_RATE) {
    emit({ type: 'decision_receipt', turn_key: turnKey, backend: null, skipped: true,
           reason: 'sampled_out', sample_rate: SHADOW_SAMPLE_RATE, student_changed_execution: false })
    return
  }
  if (shadowInFlight >= SHADOW_MAX_INFLIGHT) {
    emit({ type: 'decision_receipt', turn_key: turnKey, backend: null, skipped: true,
           reason: 'queue_saturated', in_flight: shadowInFlight, student_changed_execution: false })
    return
  }
  shadowInFlight++
  const queuedAt = Date.now()
  try {
    const child = spawn(
      LANE_PY,
      [
        LANE_BRIDGE, 'fanout',
        '--prompt', prompt.slice(0, 4000),
        '--turn-key', turnKey,
        '--backends', DECISION_BACKENDS.join(','),
        '--systemone-json', JSON.stringify(referenceLane(decision)),
        '--no-packet',
      ],
      {
        cwd: JEV_ROOT,
        env: { ...process.env, JEV_DSH_ROOT: JEV_ROOT, Z0INT_SRC: process.env.Z0INT_SRC || '/home/kvn/tmp/openjev/src' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', () => {})
    const killer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, LANE_TIMEOUT_MS)
    child.on('close', () => {
      clearTimeout(killer)
      shadowInFlight = Math.max(0, shadowInFlight - 1)
      const queueDelayMs = Date.now() - queuedAt
      try {
        const parsed = JSON.parse(out)
        const common = {
          decision_id: parsed.decision_id ?? turnKey,
          trace_id: parsed.trace_id ?? turnKey,
          turn_key: parsed.turn_key ?? turnKey,
          request_id: parsed.request_id ?? null,
          harness: 'dsh',
          policy_version: 'route-2',
          packet_chars: parsed.packet_chars ?? null,
          queue_delay_ms: queueDelayMs,
          sample_rate: SHADOW_SAMPLE_RATE,
          systemone_purchases: parsed.systemone_purchases ?? null,
          refused_lanes: parsed.refused_lanes ?? null,
          student_changed_execution: false,
        }
        for (const lane of parsed.lanes ?? []) {
          const answers = lane.answers ?? {}
          emit({
            ...common,
            type: 'decision_receipt',
            backend: lane.backend,
            backend_family: lane.backend_family ?? null,
            transport: lane.transport ?? null,
            authority: lane.authority ?? (lane.backend === 'jev_direct' ? 'production' : 'shadow'),
            unavailable: Boolean(lane.unavailable),
            skipped: Boolean(lane.skipped),
            model: lane.model ?? null,
            revision: lane.revision ?? null,
            success: Boolean(lane.success),
            error: lane.error ?? null,
            http_status: lane.http_status ?? null,
            latency_ms: lane.latency_ms ?? null,
            backend_latency_ms: lane.backend_latency_ms ?? null,
            difficulty: answers.difficulty?.value ?? null,
            difficulty_confidence: answers.difficulty?.confidence ?? null,
            difficulty_probs: answers.difficulty?.probabilities ?? null,
            specialty: answers.kind?.value ?? null,
            specialty_confidence: answers.kind?.confidence ?? null,
            specialty_probs: answers.kind?.probabilities ?? null,
            costly_mistake: answers.costly_mistake?.value ?? null,
            costly_mistake_confidence: answers.costly_mistake?.confidence ?? null,
            costly_mistake_probs: answers.costly_mistake?.probabilities ?? null,
          })
        }
        for (const cmp of parsed.comparisons ?? []) {
          emit({
            ...common,
            type: 'decision_comparison',
            reference: cmp.reference,
            shadow: cmp.shadow,
            reference_family: cmp.reference_family ?? null,
            shadow_family: cmp.shadow_family ?? null,
            reference_transport: cmp.reference_transport ?? null,
            shadow_transport: cmp.shadow_transport ?? null,
            // `parity` compares two transports of ONE family; only
            // `independent` compares different models.
            kind: cmp.kind ?? null,
            counts_as_independent_vote: Boolean(cmp.counts_as_independent_vote),
            comparable: cmp.comparable,
            questions: cmp.questions ?? null,
          })
        }
      } catch (e) {
        emit({ type: 'decision_receipt', turn_key: turnKey, error: `parse:${String(e)}`, student_changed_execution: false })
      }
    })
  } catch (e) {
    shadowInFlight = Math.max(0, shadowInFlight - 1)
    emit({ type: 'decision_receipt', turn_key: turnKey, error: String(e), student_changed_execution: false })
  }
}

/** Stable [0,1) hash of a turn key, for reproducible sampling. */
function sampleHash(key) {
  let h = 2166136261
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h / 4294967296
}

/**
 * Canonical lineage for one request. Reads DSH session metadata only; nothing is
 * inferred from session-id or agent-id shape. Parentage resolution uses
 * parentSession, supplied by a small resolver the caller passes in (the adapter
 * cannot walk the session registry from inside this hook).
 *
 * No prompt text is recorded here: this receipt exists for LINEAGE, not usage.
 */
function attribution(agent, turn, step, attempt, parentOf) {
  const header = agent?.session?.header ?? agent?.session?.sessionHeader ?? null
  const lin = lineageOf(header)
  // The agent id is the session id for a root (`session-<id>`); record both
  // without treating the naming as proof of parentage.
  const sessionId = lin.session_id ?? null
  const parentSessionId = lin.parent_session_id

  // A session with no parentSession IS a root: that is provable from the header
  // alone and needs no registry. A session WITH a parentSession cannot be
  // resolved from inside this hook, and resolving it by assuming "no parent"
  // would mint a WRONG trace for every child -- worse than an unknown. So an
  // unresolvable chain reports null and says why.
  let rootSessionId = null
  let traceId = null
  let depth = null
  let rootResolution
  if (sessionId === null) {
    rootResolution = 'no_session_metadata'
  } else if (parentSessionId == null) {
    const resolved = traceIdFor(sessionId, () => null)
    rootSessionId = resolved.root_session_id
    traceId = resolved.trace_id
    depth = 0
    rootResolution = 'self_root'
  } else {
    rootResolution = 'unresolved_in_hook'
  }

  return {
    session_id: sessionId,
    parent_session_id: parentSessionId,
    root_session_id: rootSessionId,
    trace_id: traceId,
    root_resolution: rootResolution,
    agent_id: agent?.id ?? null,
    origin: lin.origin,
    delegation_depth: lin.delegation_depth,
    // Depth is unknown when the chain is unresolved; having a parentSession is
    // itself proof this is not the root.
    role: depth === 0 ? 'root' : roleFor({ depth: depth ?? 1, origin: lin.origin }),
    turn: turn ?? null,
    step: step ?? null,
    attempt: attempt ?? 0,
    operation_id: sessionId ? operationId(sessionId, turn, step, attempt ?? 0) : null,
  }
}

function emit(rec) {
  try {
    mkdirSync(dirname(RECEIPTS), { recursive: true })
    appendFileSync(RECEIPTS, `${JSON.stringify({ ts: new Date().toISOString(), harness: 'dsh', ...rec })}\n`)
  } catch {}
}

function apiKey() {
  if (process.env.TYPESAFE_API_KEY?.trim()) return process.env.TYPESAFE_API_KEY.trim()
  try {
    for (const line of readFileSync(KEY_FILE, 'utf8').split('\n')) {
      if (line.startsWith('TYPESAFE_API_KEY=')) {
        const v = line.slice('TYPESAFE_API_KEY='.length).trim().replace(/^['"]|['"]$/g, '')
        if (v) return v
      }
    }
  } catch {}
  return ''
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && b.type === 'text' ? b.text : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/** Latest human user message for this turn, or null. */
function latestUserText(agent) {
  // 1) The messages frozen for this request. Reliable on every DSH surface —
  //    headless has an empty session surface at first request.
  try {
    const fm = agent?.frozenMessages
    if (Array.isArray(fm)) {
      for (let i = fm.length - 1; i >= 0; i--) {
        const m = fm[i]
        if (!m || m.role !== 'user') continue
        if (m.source && typeof m.source.kind === 'string' && m.source.kind !== 'user') continue
        const text = textOf(m.content)
        if (text && text.trim()) return text
      }
    }
  } catch {}
  // 2) Fall back to the session surface events.
  try {
    const s = agent?.session
    for (const seq of [...(s?.surface?.nodes ?? [])].reverse()) {
      const ev = s.eventAt(seq)
      if (ev?.type !== 'user/message') continue
      const kind = ev.data?.source?.kind
      if (kind && kind !== 'user') continue
      const text = textOf(ev.data?.message?.content ?? ev.data?.content)
      if (text && text.trim()) return text
    }
  } catch {}
  // 3) Fall back to the session event snapshot (headless fills this before surface nodes).
  try {
    const snap = agent?.session?.eventsSnapshot
    const list = Array.isArray(snap) ? snap : Array.isArray(snap?.events) ? snap.events : null
    if (list) {
      for (const ev of [...list].reverse()) {
        if (ev?.type !== 'user/message') continue
        const kind = ev.data?.source?.kind
        if (kind && kind !== 'user') continue
        const text = textOf(ev.data?.message?.content ?? ev.data?.content)
        if (text && text.trim()) return text
      }
    }
  } catch {}
  return null
}

function jevRoute(prompt, current, contextTokens, hasImages) {
  return new Promise((resolve) => {
    const key = apiKey()
    if (!key) return resolve({ ok: false, reason: 'no_key' })
    const args = ['route', '--prompt', prompt.slice(0, 4000), '--timeout', '3']
    if (current) args.push('--current', current)
    if (contextTokens > 0) args.push('--context-tokens', String(Math.min(contextTokens, 2_000_000)))
    if (hasImages) args.push('--has-images')
    // `bin/jev` is a /bin/sh wrapper that sets PYTHONPATH and runs `python3 -m jevkit`.
    const child = execFile(
      '/bin/sh',
      [JEV_BIN, ...args],
      {
        cwd: JEV_ROOT,
        timeout: TIMEOUT_MS,
        env: { ...process.env, TYPESAFE_API_KEY: key, JEV_ROUTING_CONFIG: ROUTING_CONFIG },
        maxBuffer: 1 << 20,
      },
      (err, stdout) => {
        if (err) return resolve({ ok: false, reason: `jev_error:${err.killed ? 'timeout' : 'exec'}` })
        try {
          return resolve({ ok: true, decision: JSON.parse(stdout) })
        } catch {
          return resolve({ ok: false, reason: 'malformed_response' })
        }
      },
    )
    child.on('error', () => resolve({ ok: false, reason: 'spawn_failed' }))
  })
}

function providerKnown(ctx, provider) {
  try {
    const provs = ctx.llm?.listProviders?.()
    if (Array.isArray(provs)) {
      return provs.some((p) => (typeof p === 'string' ? p : p?.id) === provider)
    }
  } catch {}
  return false
}

/**
 * Root vs child identity.
 *
 * `parentId` is NOT sufficient: DSH reports it as null for RLM children too
 * (verified live — pi2dsh-sub-* and plain-UUID child agents all arrive with
 * parentId null). The reliable discriminator is the agent id: a session's root
 * agent is named `session-<sessionId>`; bridge children are `pi2dsh-sub-*` and
 * RLM children are bare UUIDs.
 */
function isRootAgent(agent) {
  const parent = agent?.parentId ?? agent?.parent?.id ?? null
  if (parent !== null && parent !== undefined) return false
  const id = String(agent?.id ?? '')
  return id.startsWith('session-')
}

export function apply(ctx) {
  emit({ type: 'plugin_apply', root: JEV_ROOT, receipts: RECEIPTS })
  // listModels(provider) is async and requires a registered provider id.
  // Calling it with no args rejects with NO_ADAPTER for "undefined"; that
  // rejection is not a sync throw, so try/catch cannot save boot.
  try {
    const provs = ctx.llm?.listProviders?.()
    emit({
      type: 'provider_inventory',
      providers: Array.isArray(provs) ? provs.map((p) => (typeof p === 'string' ? p : (p?.id ?? null))) : String(provs),
      providerCount: Array.isArray(provs) ? provs.length : null,
    })
  } catch (e) {
    emit({ type: 'provider_inventory', err: String(e) })
  }
  const routedTurns = new WeakMap() // agent -> last routed turn number
  let textOkLogged = false
  let probeLogged = false

  ctx.on('agent/request', async (payload, next) => {
    const proposed = await next()
    const agent = payload?.agent
    const turn = payload?.turn
    const step = payload?.step
    const started = Date.now()

    // Exactly one canonical decision per ROOT real-user turn.
    //   root agent, step 1        -> buy one JEV decision
    //   same root turn, step > 1  -> reuse it (no new call)
    //   child / synthetic agent   -> usage receipt only, never JEV
    const root = isRootAgent(agent)
    if (!root || step !== 1 || routedTurns.get(agent) === turn) {
      emit({
        type: 'model_request',
        agentId: agent?.id ?? null,
        parentId: agent?.parentId ?? agent?.parent?.id ?? null,
        turn,
        step,
        purpose: !root ? 'child' : step === 1 ? 'root' : 'continuation',
        provider: proposed?.provider,
        model: proposed?.model,
        reasoningEffort: proposed?.reasoningEffort,
        routed: false,
        // Lineage only -- this receipt never carries usage.
        ...attribution(agent, turn, step, 0),
      })
      return proposed
    }
    routedTurns.set(agent, turn)

    const starting = {
      provider: proposed?.provider,
      model: proposed?.model,
      effort: proposed?.reasoningEffort,
    }
    const result = { ...proposed }

    try {
      const prompt = latestUserText(agent)
      if (prompt && !textOkLogged) {
        emit({ type: 'user_text_ok', chars: prompt.length })
        textOkLogged = true
      }
      if (!prompt && !probeLogged) {
        probeLogged = true
        let info = {}
        try {
          const s = agent?.session
          const nodes = s?.surface?.nodes
          let sample = null
          if (nodes && typeof nodes.length === 'number' && nodes.length) {
            const ev = s.eventAt(nodes[nodes.length - 1])
            sample = { lastSeqType: ev?.type ?? null, lastEvDataKeys: ev?.data ? Object.keys(ev.data) : null }
          }
          info = {
            agentKeys: Object.keys(agent || {}),
            sessionKeys: s ? Object.keys(s) : null,
            surfaceKeys: s?.surface ? Object.keys(s.surface) : null,
            nodesLen: nodes?.length ?? null,
            sample,
            fmLen: Array.isArray(agent?.frozenMessages) ? agent.frozenMessages.length : null,
            fmRoles: Array.isArray(agent?.frozenMessages)
              ? agent.frozenMessages.map((m) => m?.role ?? null).slice(-8)
              : null,
            fmLastUser: (() => {
              const fm = agent?.frozenMessages
              if (!Array.isArray(fm)) return null
              for (let i = fm.length - 1; i >= 0; i--) {
                if (fm[i]?.role !== 'user') continue
                const m = fm[i]
                return {
                  keys: Object.keys(m),
                  contentType: Array.isArray(m.content) ? 'array' : typeof m.content,
                }
              }
              return null
            })(),
            optionsKeys: agent?.options ? Object.keys(agent.options) : null,
            optionsPrompt: (() => {
              const o = agent?.options
              if (!o) return null
              for (const k of ['prompt', 'task', 'text', 'input', 'messages']) {
                if (o[k] !== undefined) return { key: k, type: Array.isArray(o[k]) ? 'array' : typeof o[k], len: Array.isArray(o[k]) ? o[k].length : String(o[k]).length }
              }
              return null
            })(),
            inboxKeys: agent?.inbox ? Object.keys(agent.inbox) : null,
            runtimeKeys: agent?.runtimeContext ? Object.keys(agent.runtimeContext) : null,
            loopCtxKeys: agent?.loopCtx ? Object.keys(agent.loopCtx) : null,
          }
        } catch (e) {
          info.err = String(e)
        }
        emit({ type: 'agent_probe', turn, step, ...info })
      }
      if (prompt && prompt.trim() && !prompt.trim().startsWith('/')) {
        const current = starting.provider ? `${starting.provider}:${starting.model}` : null
        const r = await jevRoute(prompt, current, 0, false)
        // A `_keep` answer (no tier) is a legitimate fail-open: JEV declined to
        // classify or could not route. It must NOT be reported as a routing win.
        if (r.ok && r.decision && r.decision.tier) {
          const d = r.decision || {}
          const selectedEffort = effortForTier(d.tier)
          const candidates = []
          if (d.provider && d.model_id) candidates.push({ provider: d.provider, model: d.model_id })
          if (typeof d.model === 'string' && d.model.includes(':')) {
            const idx = d.model.indexOf(':')
            const c = { provider: d.model.slice(0, idx), model: d.model.slice(idx + 1) }
            if (!candidates.some((x) => x.provider === c.provider && x.model === c.model)) candidates.push(c)
          }
          let chosen = null
          for (const c of candidates) {
            if (providerKnown(ctx, c.provider)) {
              chosen = c
              break
            }
          }
          if (selectedEffort && 'reasoningEffort' in proposed) result.reasoningEffort = selectedEffort
          if (chosen) {
            result.provider = chosen.provider
            result.model = chosen.model
          }
          emit({
            type: 'jev_decision',
            agentId: agent?.id ?? null,
            turn,
            policy: d.policy ?? null,
            tier: d.tier,
            difficulty: d.difficulty,
            specialty: d.specialty,
            confidence: d.confidence,
            costly_mistake: d.costly_mistake,
            starting_provider: starting.provider,
            starting_model: starting.model,
            starting_effort: starting.effort,
            selected_provider: result.provider,
            selected_model: result.model,
            selected_effort: result.reasoningEffort,
            canonical_candidate: d.model ?? null,
            route_changed:
              Boolean(chosen) && (chosen.provider !== starting.provider || chosen.model !== starting.model),
            effort_changed: result.reasoningEffort !== starting.effort,
            model_routing: chosen ? 'applied' : 'unavailable_kept_current',
            fallback_reason: null,
            jev_latency_ms: d.latency_ms,
            adapter_latency_ms: Date.now() - started,
          })
          // Shadows only: one packet, concurrent lanes, never awaited here.
          runDecisionPlane({ prompt, turn, agentId: agent?.id ?? null, decision: d })
        } else {
          emit({
            type: 'jev_decision',
            agentId: agent?.id ?? null,
            turn,
            kept_current: true,
            fallback_reason: r.ok ? (r.decision?.reason ?? 'no_tier') : r.reason,
            starting_provider: starting.provider,
            starting_model: starting.model,
            starting_effort: starting.effort,
            selected_provider: result.provider,
            selected_model: result.model,
            selected_effort: result.reasoningEffort,
            route_changed: false,
            effort_changed: result.reasoningEffort !== starting.effort,
            adapter_latency_ms: Date.now() - started,
          })
        }
      }
    } catch (e) {
      emit({
        type: 'jev_decision',
        agentId: agent?.id ?? null,
        turn,
        fallback_reason: `adapter_exception:${String(e)}`,
        route_changed: false,
        effort_changed: false,
      })
    }

    emit({
      type: 'model_request',
      agentId: agent?.id ?? null,
      parentId: agent?.parentId ?? agent?.parent?.id ?? null,
      turn,
      step,
      purpose: 'root',
      ...attribution(agent, turn, step, 0),
      provider: result.provider,
      model: result.model,
      reasoningEffort: result.reasoningEffort,
      routed: true,
    })
    return result
  })
}
