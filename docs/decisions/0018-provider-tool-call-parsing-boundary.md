# Decision 0018: Provider tool-call parsing boundary without execution

Status: **accepted internal architecture direction; no public API contract changes**

Date: 2026-11-09 (Asia/Shanghai).

## Context

[ADR 0010](0010-first-real-model-slice.md) and [ADR 0012](0012-streaming-output-progress.md) keep the phase-1 HTTP task path single-turn and reject model-requested tools. [ADR 0013](0013-bounded-tool-capability-kernel.md) accepts an internal fixture-only tool capability kernel, but deliberately does not wire it to a provider or the Runtime API. [ADR 0017](0017-public-tool-request-approval-ledger.md) accepts a durable public request/approval ledger and requires provider adapters to normalize structured tool calls into the accepted provider-neutral proposal through a separate accepted adapter ADR. It also states that a ledger approval is not execution permission.

`docs/AI_TASK_QUEUE.md` places provider tool-call parsing and the execution boundary next. Implementing parsing, provider adapter integration, ledger request creation, durable execution results, crash-safe side effects, executor isolation, and per-tool grants in one slice would decide too many security contracts at once. A model response is untrusted data; a structured function call must not silently become a capability, a task transition, or a host side effect.

This ADR accepts the smallest executable boundary: a pure parser that turns one OpenAI Chat Completions-compatible non-streaming function tool call into a transient provider-neutral observation. It does not change the provider adapter, task path, public API, configuration schema, event contract, or the internal `ToolCapabilityKernel`. Execution remains blocked.

## Decision

### 1. Scope and version

The OpenAPI document, runtime status version, package version, CLI usage version, provider `User-Agent`, health API version, accepted sixteen-path set, and all public schemas remain `0.6.0` / API version `1` as accepted by ADR 0017. No route, event envelope, configuration schema, durable table, or runtime dependency is added.

`src/runtime/provider-tool-call.ts` is a pure internal parsing boundary. It accepts the whole non-streaming Chat Completions response shape used by `src/runtime/magpie-provider.ts`, not streaming deltas, provider SDK objects, or a vendor-specific HTTP client. It has no I/O and no mutable module state.

### 2. Accepted provider shape

The parser accepts exactly one choice whose `message.tool_calls` array contains exactly one function call. The call must have a bounded opaque `id`, `type: 'function'`, and a `function` object with only `name` and `arguments`. `arguments` must be a JSON string of bounded length that parses to a plain object. An empty or non-string `message.content` is accepted only when it is null, absent, empty, or whitespace; a non-empty answer mixed with a tool call is rejected.

Multiple tool calls, unsupported tool types, unknown call or function fields, missing or sensitive identifiers, malformed JSON, non-object arguments, oversized arguments, streaming `delta` shapes, and provider payloads that cannot be normalized are rejected with bounded validation issues. The parser never returns raw provider response bodies, reasoning text, credentials, or arbitrary nested provider fields.

### 3. Normalized observation

A valid parse returns one frozen `ProviderToolCallObservation` with `version: 1`, `kind: 'tool_call'`, `provider: 'openai-chat-completions'`, `providerToolCallId`, `toolCall`, and `argumentsDigest`. `toolCall` is the accepted `ToolCallProposal` from `src/runtime/tool-request.ts`: a bounded `toolName` and scalar `arguments`. `argumentsDigest` uses the existing `arg_` canonical digest. The parser reuses `validateToolCallProposal` so secret-like names, keys, values, absolute URLs, unknown tool-call fields, nested values, and excessive argument counts are rejected by one validation owner.

The observation is transient. Its bounded scalar arguments are not persisted, logged, returned over HTTP, or written into durable event `data`. It carries no `taskId`, `attempt`, `compositionNodeId`, `configurationRevisionId`, approval, decision, executor, grant, or result. It is therefore not a ledger request and not an execution request.

### 4. No-wiring and no-execution boundary

`TaskService`, `OpenAiChatCompletionsProvider`, HTTP routes, `SqliteTaskStore`, and `ToolCapabilityKernel` do not import or call the parser in this slice. The live provider adapter continues to reject tool calls, and the HTTP task path stays single-turn for `schemaVersion: 1` and deterministic for `schemaVersion: 2`. No public event type changes and no `tool.executed`, `tool.failed`, `tool.denied`, or `tool.replayed` event is emitted.

The parser does not import `tool-capability.ts`, `task-service.ts`, `task-store.ts`, Fastify, HTTP transport, private-file I/O, or SQLite. It does not create a tool request, record an approval, transition a task, resolve a secret, start an MCP server, load a Skill or plugin, grant per-tool authority, or invoke an executor. A ledger approval remains state, never execution permission.

### 5. Sequencing

Provider adapter integration is a separate accepted slice. That slice must decide how a provider returns this observation to `TaskService`, how an eligible composition node is selected, whether a client explicitly creates a ledger request, and how cancellation interacts with an unexecuted proposal. Durable execution results, crash-safe side effects, real executor isolation, per-tool grants, MCP lifecycle, and whether `ToolCapabilityKernel` is replaced or migrated require further ADRs. Streaming tool-call accumulation and multi-turn tool loops remain open.

## Options

### A. Wire provider tool calls into the task path now

Consequences: a visible tool-call demo, but settles composition node selection, ledger request creation, approval semantics, and execution authority before an accepted adapter contract exists. Rejected because it expands the untrusted model surface too early.

### B. Keep rejecting all tool calls and postpone parsing

Consequences: no code change, but leaves provider normalization implicit and lets a weaker model invent an unsafe parser while integrating the provider. Rejected because the queue asks for an executable parsing boundary first.

### C. Pure parser with explicit no-wiring guardrails (recommended)

Consequences: one vendor-shaped payload maps to the accepted normalized proposal and digest behind deterministic tests, while every execution and persistence decision remains blocked. The cost is an intentionally unwired internal module. This is the accepted direction.

### D. Add a public provider tool-call route

Consequences: exposes untrusted provider payloads or raw tool arguments through the Runtime API before authentication, pairing, and versioned request identity are accepted. Rejected.

## Consequences

The repository gains a deterministic boundary for one OpenAI-compatible non-streaming function tool call. `ToolCallProposal` remains the single normalized proposal type, and `arg_` remains the single argument digest. ADR 0013's internal kernel is unchanged; ADR 0017's ledger is unchanged; ADR 0016's topology-neutral composition remains the only accepted source of composition node identity. No public contract or version changes, so Pagurus needs no update in this slice.

`docs/AI_TASK_QUEUE.md` records this slice as done and makes provider adapter integration and the execution boundary the first next slice. Pagurus's tool approval client remains second. Repository guardrails are updated in the same slice as this accepted ADR to require ADR 0018 status, keep the unchanged `0.6.0` sixteen-path contract, reject parser imports of forbidden runtime boundaries, and prove the parser is not wired into the task or provider path.

## Validation

- Pure parser tests cover a valid normalized observation, stable `arg_` digest, no-tool-call responses, multiple choices, mixed answer text, multiple or unsupported tool calls, malformed identifiers, unknown fields, malformed or oversized arguments JSON, non-object/nested/secret-like arguments, invalid tool names, and streaming delta shapes.
- Tests assert the observation contains no raw provider envelope, task identity, composition node identity, ledger decision, approval, or execution vocabulary.
- Repository guardrails check ADR 0018 status, the unchanged OpenAPI path set and version, parser boundary imports, no-wiring assertions for `TaskService`, `OpenAiChatCompletionsProvider`, and HTTP routes, and no public execution vocabulary in the parser.
- Conchbase runs `npm run check`, `npm test`, and `npm run build`. Tests use deterministic local objects; no real credential, user data, public-network dependency, real model, real tool, or provider SDK is used.
