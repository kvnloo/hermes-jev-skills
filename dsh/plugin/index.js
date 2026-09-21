// Thin DSH adapter for canonical hermes-jev-skills policy.
// Phase 1: probe the agent/request contract and emit per-request receipts.
export const name = 'hermes-jev-dsh'

export function apply(ctx) {
  const log = (m, o) => {
    try { console.error(`[hermes-jev-dsh] ${m}` + (o === undefined ? '' : ` ${JSON.stringify(o)}`)) } catch {}
  }
  log('apply', { services: ['llm','sessions','sessionProjections','tokenMeter','logger'].filter(s => { try { return !!ctx[s] } catch { return false } }) })

  ctx.on('agent/created', (payload) => {
    try { log('agent/created', { keys: Object.keys(payload || {}) }) } catch (e) { log('agent/created err', String(e)) }
  })

  ctx.on('agent/request', async (payload, next) => {
    let proposed
    try {
      proposed = await next()
    } catch (e) {
      log('agent/request next threw', String(e)); throw e
    }
    try {
      log('agent/request', {
        payloadKeys: Object.keys(payload || {}),
        turn: payload?.turn, step: payload?.step,
        proposed,
      })
    } catch {}
    return proposed
  })

  ctx.on('turn/start', (payload) => { try { log('turn/start', { keys: Object.keys(payload || {}) }) } catch {} })
  ctx.on('user/message', (payload) => { try { log('user/message', { keys: Object.keys(payload || {}) }) } catch {} })
}
