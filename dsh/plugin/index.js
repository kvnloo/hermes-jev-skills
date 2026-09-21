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
import { execFile } from 'node:child_process'
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
      provider: result.provider,
      model: result.model,
      reasoningEffort: result.reasoningEffort,
      routed: true,
    })
    return result
  })
}
