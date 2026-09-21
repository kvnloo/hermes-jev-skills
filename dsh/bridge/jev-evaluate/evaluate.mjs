// Native typed evaluation for the Jev backend family.
//
// ONE backend family, TWO transports:
//   typesafe_direct     @ai-sdk/typesafe-ai  -> POST {baseURL}/systemone
//   vercel_ai_gateway   @ai-sdk/gateway      -> POST /v4/ai/evaluation-model
//
// Both go through the AI SDK's `experimental_evaluate()`. This file does NOT
// prompt Jev as a chat model, does NOT use generateObject, does NOT build a
// JSON-output prompt, and does NOT parse free-form text. `state` plus typed
// `questions` go in; typed Choice / Score / Boolean answers and distributions
// come out.
//
// Wire format captured from a local mock (see mock_gateway.mjs):
//   POST /v4/ai/evaluation-model
//   ai-model-id: typesafe-ai/jev
//   ai-evaluation-model-specification-version: 4
//   { state, questions, providerOptions }
// The wire question type for a boolean is `boolean` on the gateway and `noul`
// on the direct TypeSafe endpoint; the SDKs perform that translation, so
// callers always use `boolean`.
//
// stdin:  { transport, state, questions, apiKey, model?, timeoutMs? }
// stdout: { ok, family, transport, model, answers, confidence, rounding, usage, error }
import { experimental_evaluate } from 'ai'
import { createTypeSafeAi } from '@ai-sdk/typesafe-ai'
import { createGateway } from '@ai-sdk/gateway'

const FAMILY = 'jev'

const TRANSPORTS = {
  typesafe_direct: {
    model: 'jev-latest',
    build: (apiKey) => createTypeSafeAi({ apiKey }).evaluationModel('jev-latest'),
  },
  vercel_ai_gateway: {
    model: 'typesafe-ai/jev',
    // No custom baseURL: the provider default is https://ai-gateway.vercel.sh/v4/ai,
    // and /v4/ai/evaluation-model is the live typed route.
    build: (apiKey) => createGateway({ apiKey }).evaluationModel('typesafe-ai/jev'),
  },
}

/** Canonical z0int questions use `options`/`levels`; the SDK uses `criteria`. */
function toSdkQuestion(q) {
  if (q.type === 'choice') {
    if (q.criteria) return { type: 'choice', instructions: q.instructions, criteria: q.criteria }
    const criteria = {}
    for (const o of q.options ?? []) criteria[o.id] = o.description ?? null
    return { type: 'choice', instructions: q.instructions, criteria }
  }
  if (q.type === 'score') {
    if (q.criteria) return { type: 'score', instructions: q.instructions, criteria: q.criteria }
    return { type: 'score', instructions: q.instructions, criteria: [...(q.levels ?? [])] }
  }
  const out = { type: 'boolean', instructions: q.instructions }
  if (q.false_criterion || q.true_criterion) {
    out.criteria = { false: q.false_criterion ?? null, true: q.true_criterion ?? null }
  }
  return out
}

/** Normalize the SDK's typed answer into the canonical DecisionAnswer shape. */
function fromSdkAnswer(a) {
  if (a.type === 'choice') return { type: 'choice', value: a.choice, probabilities: a.probabilities ?? null }
  if (a.type === 'score') return { type: 'score', value: a.score, probabilities: a.probabilities ?? null }
  return { type: 'boolean', value: a.probability, probabilities: { true: a.probability, false: 1 - a.probability } }
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let s = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (d) => { s += d })
    process.stdin.on('end', () => resolve(s))
    process.stdin.on('error', reject)
  })
}

async function main() {
  let req
  try {
    req = JSON.parse(await readStdin())
  } catch (e) {
    return { ok: false, family: FAMILY, error: `bad stdin: ${String(e)}` }
  }
  const t = TRANSPORTS[req.transport]
  if (!t) return { ok: false, family: FAMILY, transport: req.transport, error: 'unknown transport' }
  if (!req.apiKey) return { ok: false, family: FAMILY, transport: req.transport, error: 'no credential for transport' }

  const questions = Object.fromEntries(Object.entries(req.questions ?? {}).map(([id, q]) => [id, toSdkQuestion(q)]))
  try {
    const result = await experimental_evaluate({
      model: t.build(req.apiKey),
      state: req.state,
      questions,
      abortSignal: AbortSignal.timeout(req.timeoutMs ?? 30000),
    })
    return {
      ok: true,
      family: FAMILY,
      transport: req.transport,
      model: req.model ?? t.model,
      answers: Object.fromEntries(Object.entries(result.answers).map(([id, a]) => [id, fromSdkAnswer(a)])),
      // TypeSafe reports confidence separately from the distribution.
      confidence: result.providerMetadata?.typesafe?.confidence ?? null,
      rounding: result.rounding ?? null,
      usage: result.usage ?? null,
      response_id: result.response?.id ?? null,
    }
  } catch (e) {
    const status = e?.statusCode ?? e?.cause?.statusCode ?? e?.response?.status ?? null
    return {
      ok: false,
      family: FAMILY,
      transport: req.transport,
      model: req.model ?? t.model,
      http_status: typeof status === 'number' ? status : null,
      error: String(e?.message ?? e).slice(0, 400),
    }
  }
}

console.log(JSON.stringify(await main()))
