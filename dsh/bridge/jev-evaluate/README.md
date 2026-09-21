# jev-evaluate — native typed Jev evaluation

One backend family (`jev`), two transports, both through the AI SDK's
**`experimental_evaluate()`**. No chat prompting, no `generateObject`, no
JSON-output prompt, no free-form text parsing.

| transport | SDK provider | wire endpoint |
| --- | --- | --- |
| `typesafe_direct` | `@ai-sdk/typesafe-ai` | `POST {baseURL}/systemone` |
| `vercel_ai_gateway` | `@ai-sdk/gateway` | `POST /v4/ai/evaluation-model` |

```js
const result = await experimental_evaluate({
  model: createGateway({ apiKey }).evaluationModel('typesafe-ai/jev'),
  state,        // shared state, identical for both transports
  questions,    // typed choice / score / boolean
})
```

## Verified wire format

Captured from a local mock (`mock_gateway.mjs`), not inferred:

```
POST /v4/ai/evaluation-model
ai-model-id: typesafe-ai/jev
ai-evaluation-model-specification-version: 4
ai-gateway-auth-method: api-key
ai-gateway-protocol-version: 0.0.1

{ "state": {...},
  "questions": { "difficulty": { "type": "score",  "instructions": "...", "criteria": ["trivial", ...] },
                 "kind":       { "type": "choice", "instructions": "...", "criteria": { "coding": "software" } },
                 "costly":     { "type": "boolean","instructions": "...", "criteria": { "false": "...", "true": "..." } } },
  "providerOptions": {} }
```

There is no `messages` array and no `response_format` — that is the whole point.

Notes that cost real debugging time:

- **The wire endpoint is `/v4/ai/evaluation-model`, not `/v1/evaluate` and not
  `/systemone`.** `createGateway()`'s default base is `https://ai-gateway.vercel.sh/v4/ai`.
  Pointing the *TypeSafe* provider at the Gateway yields `POST /v1/systemone` → 404.
  A nonsense-path control also 404s, and `/v4/ai/evaluation-model` returns 403,
  which is how we know the route is real and merely gated.
- **A boolean is `noul` on the direct TypeSafe wire and `boolean` on the
  gateway wire**, and the response field for a noul is `noul`, not `probability`.
  The SDKs do that translation, which is a good reason to use them rather than
  hand-rolling the HTTP calls.
- The SDK validates the returned distribution against the declared criteria and
  rejects a response whose probabilities don't cover the options.
- TypeSafe confidence is **separate from the distribution** and arrives at
  `providerMetadata.typesafe.confidence[questionId]`.

## Install

```
npm install          # ai, @ai-sdk/gateway, @ai-sdk/typesafe-ai
```

`node_modules` is gitignored. Version alignment matters: `ai@7` requires
`@ai-sdk/gateway@4`; `@ai-sdk/gateway@2` does not expose `evaluationModel` at all.

## Use

```
echo '{"transport":"vercel_ai_gateway","apiKey":"...","state":{...},"questions":{...}}' | node evaluate.mjs
```

Prints one JSON object: `{ok, family, transport, model, answers, confidence,
rounding, usage, http_status, error}`.

Current live status of `vercel_ai_gateway`: **403, account-wide** ("requires a
valid credit card on file"). The route and the request are correct; the account
is what is blocked. `typesafe_direct` needs `TYPESAFE_AI_API_KEY`, which is not
in the DSH credential store (the production path uses jevkit's own key).
