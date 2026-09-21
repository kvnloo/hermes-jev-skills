# DSH model providers added in this phase

Two ordinary DSH providers were registered through DSH's own mechanism — the
hot-reloaded settings document (`$DSH_HOME/settings.yaml`, section `llm-pi-ai`),
which is exactly what the web Models page writes. Credential *injection* and
provider *registration* are separate, and both are present: each route names a
credential reference (`apiKeyEnv`) that DSH resolves per request.

No credential value is stored in this repo. `discover_groq_models.py` reads the
store by reference name and never prints the value.

## Registered

```yaml
llm-pi-ai:
  providers:
    groq:
      displayName: Groq
      apiKeyEnv: GROQ_API_KEY
      api: openai-completions
      baseURL: https://api.groq.com/openai/v1
      models: [...]          # generated from the LIVE catalog
    vercel:
      displayName: Vercel AI Gateway
      apiKeyEnv: AI_GATEWAY_API_KEY
      api: openai-completions
      baseURL: https://ai-gateway.vercel.sh/v1
      models: [...]
```

Groq's model list is generated, not hand-maintained:

```
./discover_groq_models.py          # print the fragment from the live catalog
./discover_groq_models.py --check  # report drift against what is configured
```

The live Groq catalog shares almost nothing with the catalog bundled in pi-ai
(which still lists `llama-3.1-8b-instant`, `llama-3.3-70b-versatile`, …). Six
text→text models are live: `allam-2-7b`, `groq/compound`, `groq/compound-mini`,
`openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `qwen/qwen3.8-27b`.

## Blockers found (not worked around)

**Groq — free-tier TPM is below DSH's system prompt.** The route registers,
the credential resolves, and DSH genuinely reaches Groq, but every tool-capable
Groq model caps at 8 000 tokens/minute on the free tier while DSH's request is
8 712 tokens:

```
groq: RATE_LIMIT: 413 Request too large for model `openai/gpt-oss-20b`
  ... (TPM): Limit 8000, Requested 8712
```

`groq/compound` and `groq/compound-mini` have 70 000 TPM but reject tools
outright (`tool calling is not supported with this model`), and DSH always sends
tool definitions. So no successful Groq completion through DSH is possible on
the free tier — it needs a Groq Dev-tier upgrade. Nothing here works around it.

A prompt-trimming overlay was attempted (disabling skill/goal/plan/commands
rows) and abandoned: it deactivates three interdependent rows and the tree fails
to boot. A genuinely minimal tree (`@deepseek-ai/dsh-sdk-minimal`, which does not
layer over dsh-base) is the clean way to test a small-prompt provider later.

**Vercel AI Gateway — account requires a card on file.** The key authenticates
for discovery: `GET /v1/models` returns 200 with 376 models, including a
`pricing` object. Every completion, however, is refused account-wide:

```
403 AI Gateway requires a valid credit card on file to service requests.
```

That is all 376 models, including the seven whose `pricing.input`/`pricing.output`
metadata is `"0"`. Verified against `openai/gpt-4o-mini`, `openai/gpt-oss-20b`,
`google/gemini-2.0-flash`, `poolside/laguna-s-2.1-free` and
`inclusionai/ling-3.0-flash-sante-free` — identical 403.

**No model was inferred free from its name.** Seven models carry zero-cost
pricing metadata; one of them (`inclusionai/ling-3.0-flash-fin`) also declares
`varies_by_provider: true`, so its zero is not a flat guarantee. All seven are
unreachable anyway.

Because the account is blocked, `typesafe-ai/jev` over Vercel Gateway cannot
serve decisions — see `../bridge/shadow_decide.py`, lane `vercel_jev`, which
attempts the real call each turn and records the 403 rather than hiding it.
