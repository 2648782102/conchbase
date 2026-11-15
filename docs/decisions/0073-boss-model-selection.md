# Decision 0073: The Boss conversation uses its configured model

Status: **accepted and implemented Boss model selection fix**

Date: 2026-11-15 (Asia/Shanghai).

## Context

A live probe of the Boss Agent returned `HTTP 402` on every message. The operator had set `CONCHBASE_BOSS_MODEL` to a working model, and a direct request to that model succeeded, so the failure looked like an upstream problem.

`BossModeService.resolveModelReference()` was taking the **first entry** from the provider catalog:

```ts
const models = await taskService.listProviderModels();
const first = models[0];
return { providerId: first.providerId, modelId: first.modelId };
```

The first catalog entry happened to be `deepseek/deepseek-flash`, whose quota was exhausted. The operator's configured model was ignored for the Boss conversation while still being honoured for the parser — so the same process used two different models depending on which code path ran.

Two defects, one symptom:

1. The Boss conversation model was chosen by catalog order, not by configuration.
2. The structured intent parser made a streaming request and then parsed the response with `response.json()`, which fails on any SSE body. That surfaced as `Model provider returned invalid JSON` whenever the upstream honoured `stream: true`.

## Decision

1. `BossModeService` accepts an explicit `bossModelReference`. When present it is used for the Boss conversation, and the provider catalog is consulted only when no model is configured.
2. `main.ts` and `cli.ts` pass `{ providerId: BOSS_UPSTREAM_PROVIDER_ID, modelId: config.bossModel ?? config.defaultModel }`, so the Boss conversation uses exactly the model the operator configured.
3. `BOSS_UPSTREAM_PROVIDER_ID` is a named constant rather than a string literal, so a future second adapter changes one place.
4. The structured intent parser now honours the response's own `content-type`: SSE bodies are read with a streaming reader, JSON bodies with `response.json()`. A conforming upstream that streams no longer breaks the non-streaming code path.
5. Per-submission `modelOverride` still wins when a client supplies one, because that is an explicit client choice. The Agent Chat Boss conversation deliberately does not supply one.

## Options

### A. Order the catalog so a working model is first

Consequences: the operator's configuration still means nothing, and the failure returns whenever that entry's quota changes. Rejected.

### B. Require an explicit `modelOverride` from every client

Consequences: clients would have to know the operator's model choice, which is server configuration. Rejected.

### C. Configured model wins; catalog is the fallback; honour the response content type

Consequences: configuration is authoritative, the fallback still works for a fresh install, and the parser stops assuming a response format from the request. Accepted.

## Validation

- `tests/boss-mode-service.test.ts` asserts the configured Boss model wins over the catalog's first entry.
- `tests/organization-intent-parser.test.ts` asserts a structured parser reads an SSE reply and still accepts a plain JSON body.
- Live Boss probe: before the fix, `HTTP 402` on every message; after the fix, a correct reply that also stated its capability boundaries.
- `npm run check`, `npm test` (320), and `npm run build` pass.

## Consequences

The Boss conversation now runs on the model the operator chose, and a streaming upstream no longer breaks the intent parser. The lesson recorded here: a "model unavailable" error can be a selection bug wearing an upstream costume. When a configured value exists, an arbitrary default must never override it silently.
