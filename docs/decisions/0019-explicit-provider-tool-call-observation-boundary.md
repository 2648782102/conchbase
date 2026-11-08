# Decision 0019: Explicit provider tool-call observation boundary

Status: **accepted product and public API direction; contracts are versioned in `docs/openapi.yaml`**

Date: 2026-11-09 (Asia/Shanghai).

## Context

[ADR 0010](0010-first-real-model-slice.md) and [ADR 0012](0012-streaming-output-progress.md) keep the live HTTP task path single-turn for `schemaVersion: 1`, deterministic for `schemaVersion: 2`, and reject model-requested tools. [ADR 0013](0013-bounded-tool-capability-kernel.md) keeps the fixture-only `ToolCapabilityKernel` unwired. [ADR 0017](0017-public-tool-request-approval-ledger.md) accepts a durable provider-neutral request/approval ledger and states that an approval is never execution permission. [ADR 0018](0018-provider-tool-call-parsing-boundary.md) accepts a pure, unwired parser for one OpenAI Chat Completions-compatible non-streaming function tool call.

`docs/AI_TASK_QUEUE.md` makes provider adapter integration the next bounded slice. That slice must decide how `OpenAiChatCompletionsProvider` returns ADR 0018's observation to `TaskService`, how an eligible composition node is selected, whether a client explicitly creates a ledger request, and how cancellation interacts with an unexecuted proposal. Deciding executor trust, durable execution results, crash-safe side effects, real host isolation, per-tool grants, and MCP lifecycle in the same slice would settle too many security contracts at once. A model response is untrusted data; a normalized observation must not silently become a task transition, a ledger record, or a host side effect.

The local Runtime API remains loopback-only and unauthenticated. A tool execution route would still be an unsafe shortcut. This ADR accepts a narrow, versioned adapter boundary: the provider can normalize exactly one non-streaming structured tool call, the live v1 streaming path can carry the normalized observation without executing it, and a separate public observation endpoint lets a client explicitly submit an untrusted provider payload for pure parsing. No automatic ledger request is created and no tool is executed.

## Decision

### 1. Version and capability

The OpenAPI document, runtime status version, package version, CLI usage version, provider `User-Agent`, and `RUNTIME_RESPONSE_FIXTURE.version` become `0.7.0`. The health API version remains `1`. `/v1/runtime` advertises `provider-tool-call-observation` in addition to the accepted `0.6.0` capabilities. The accepted path set becomes seventeen routes. Configuration document revisions, task state, event envelope, ledger request identity, and durable tables are unchanged.

One route is added:

- `POST /v1/provider-observations/tool-calls` accepts one bounded provider tool-call observation request and returns one transient normalized observation or an explicit no-observation result.

No execution route, tool listing route, registration route, MCP lifecycle route, Skills loader route, plugin host route, secret resolution route, generated client, durable observation table, or new runtime dependency is added. No remote binding, authentication, pairing, or SSE transport is added.

### 2. Internal adapter contract

`src/runtime/model-adapter.ts` owns an internal versioned `ProviderToolCallObservation` type with `version: 1`, one normalized `ToolCallProposal`, one `arg_` arguments digest, and the bounded opaque provider tool-call id from ADR 0018. A separate `ProviderModelTurn` union gains a `tool_call_observation` kind that carries only this observation. `ModelTurn` stays unchanged for the deterministic `task-runner.ts` acceptance harness; its fixture `tool_call` kind never becomes the live provider path.

`OpenAiChatCompletionsProvider.nextTurn` imports ADR 0018's pure parser. It keeps one `stream: false` request, rejects later turns, forwards cancellation, and normalizes errors without response bodies. A payload with exactly one accepted function tool call becomes a `tool_call_observation` turn. A final answer becomes a `final` turn. Unsupported, mixed, malformed, multiple, streaming-delta, or provider-specific tool-call shapes become a bounded provider error. No task, composition, ledger, approval, executor, or result identity is included in the model turn.

`OpenAiChatCompletionsProvider.streamTurn` returns a new `StreamingModelTurn` union: `{ kind: 'final', output }` or `{ kind: 'tool_call_observation', observation }`. It continues to ignore reasoning text, reject streaming `delta.tool_calls` shapes, and accumulate only answer-text chunks. It accepts one final non-streaming-shaped `choices[0].message.tool_calls` payload through the same parser. This is not streaming tool-call delta accumulation: one whole message-shaped tool call is accepted, split deltas and partial arguments remain rejected, and full streaming accumulation requires a later ADR. A streaming tool-call observation never invokes `onOutputDelta`, never writes `partialOutput`, and never executes a tool.

### 3. Explicit public observation boundary

The public observation request carries `version: 1`, `provider: 'openai-chat-completions'`, and one bounded `payload` object. The HTTP boundary rejects unknown top-level fields, unsupported providers, nested or oversized payloads, absolute URLs, secret-like values, and provider response bodies that are not plain JSON objects. The request is not a task, ledger request, approval, capability grant, or execution request. It carries no task id, attempt, node id, revision id, credentials, or raw provider envelope beyond the validated provider payload fields.

The runtime calls the same pure ADR 0018 parser and returns `200` with `{ observation: ProviderToolCallObservation | null }`. `null` means the accepted provider shape contains no tool call; it is not an error. Parser validation issues return `400` with the bounded `details` shape. The response contains only `version`, `kind`, `provider`, `providerToolCallId`, `toolCall`, and `argumentsDigest`; the bounded scalar arguments inside `toolCall.arguments` are transient response data so a client can construct an explicit `POST /v1/tool-requests` proposal. Raw provider response fields, reasoning text, secrets, credentials, absolute URLs, task identity, composition node identity, approval state, and executor output are never returned. No database row, durable event, task transition, or ledger request is created. A response is transient and is not replayable by id.

### 4. Node selection, ledger creation, and cancellation

The runtime does not select an eligible composition node from a provider observation. Conchbase's pinned `schemaVersion: 2` configuration and its `cmp_` identity remain the only accepted sources of node identity. A client that wants a durable tool request must explicitly call `POST /v1/tool-requests` with `taskId`, `attempt`, `compositionNodeId`, and the normalized `toolCall`; that route keeps every ADR 0017 eligibility check and digest-only durable identity. The observation endpoint never calls `createToolRequest`, never writes to `SqliteTaskStore`, and never imports `ToolCapabilityKernel`.

`TaskService.executeSingleTurn` handles a streaming `tool_call_observation` by marking the task `failed` with an explicit observation-not-actionable error. This preserves the accepted single-turn task contract and makes an untrusted, unexecuted model proposal visible without inventing a new state or event. Cancellation is checked after the provider stream and before any observation handling; cancellation wins and no observation is acted upon. `TaskService` does not create a ledger request, change composition dispatch, or execute a tool. There is no `waiting_approval` transition from a provider observation in this slice.

A v1 task with an observation has no `task.completed` output and no `task.output_delta` from the tool call; its terminal `failed` event carries the existing bounded `error` field only. The public event vocabulary is unchanged and still excludes `tool.executed`, `tool.failed`, `tool.denied`, and `tool.replayed`. A ledger approval remains durable state, never execution permission.

### 5. Security and non-goals

Conchbase remains the execution authority. No UI reads or writes private runtime files or database tables. Loopback-only binding and the single-owner SQLite boundary are unchanged. Provider output is untrusted. A Skill never grants tools. A normalized observation never grants a capability. The internal `ToolCapabilityKernel` remains fixture-only and unwired.

Streaming tool-call delta accumulation, multi-turn tool loops, model-driven composition nodes, per-node model selection, automatic ledger request creation, automatic node selection, public tool execution, durable execution results, crash-safe side effects, real executor isolation, per-tool grants, MCP lifecycle, generated clients, authentication/pairing, remote approval, SSE, retention, and direct vendor providers remain out of scope. Each requires its own accepted ADR before a public or security contract changes. Pagurus adds no observation UI or write route in this slice; its read-only capability parsing accepts the new capability string as data.

## Options

### A. Full provider-to-executor loop now

Consequences: visible real-tool demo, but requires node selection, ledger creation, approval semantics, executor isolation, crash-safe side effects, and grants before an untrusted observation contract is stable. Rejected because it settles the most security-sensitive boundaries too early.

### B. Automatically create a pending ledger request from every observation

Consequences: less client work, but silently turns untrusted provider output into durable task-scoped state and needs a node-selection policy. It would also make repeated provider observations create replayable ledger records without an explicit user/client decision. Rejected; the ledger remains explicit and provider-neutral.

### C. Keep the provider rejecting tool calls and expose only a pure parser route

Consequences: smallest public change, but does not connect `OpenAiChatCompletionsProvider` to ADR 0018 and leaves the next model free to invent a second normalization path. Rejected because the queue asks for provider adapter integration.

### D. Explicit adapter observation with no execution (recommended)

Consequences: one normalization owner is wired into both provider methods, the live task path can fail visibly on an untrusted observation, and clients get a versioned transient route for explicit normalization. It adds one public route and one internal turn kind, but no task-state, ledger, executor, or durable-table change. Weaker models get executable guardrails that an observation is not permission. This is the accepted direction.

## Consequences

The OpenAPI contract becomes `0.7.0` with seventeen paths. Existing task, event, model, configuration, and tool request/approval routes keep their accepted shapes. `/v1/runtime` gains `provider-tool-call-observation`; clients that validate exact capability sets must update. `ProviderToolCallObservation` becomes a shared internal adapter type, and ADR 0018's parser remains the sole owner of provider payload normalization. ADR 0017's ledger is unchanged; a client must explicitly submit a normalized `toolCall` with task and composition identity. ADR 0013's internal kernel is unchanged. ADR 0016's topology-neutral composition remains the only accepted source of composition node identity.

The live v1 streaming provider no longer rejects one whole message-shaped non-streaming tool call outright: it returns a transient observation that `TaskService` fails visibly without executing. Mixed answer/tool-call responses, streaming tool-call deltas, multiple calls, and secret-like payloads remain rejected. Streaming tool-call accumulation and model-driven composition are still open. Pagurus needs no implementation change in this slice because its runtime capability validator accepts arbitrary strings; its documentation records `0.7.0` as read-only capability context.

Repository guardrails are updated in the same slice to accept ADR 0019, require the `0.7.0` contract and seventeen-path set, prove that the parser is wired only into the provider and the pure observation route, and continue rejecting public execution vocabulary, raw provider envelopes, ledger auto-creation, private-file access from HTTP, and `ToolCapabilityKernel` imports.

## Validation

- Provider tests cover a valid non-streaming function tool call returning `tool_call_observation`, a final answer, a streaming whole-message observation, rejected streaming tool-call deltas, mixed answer/tool-call payloads, malformed parser shapes, HTTP errors, cancellation, unchanged request shape, and no `onOutputDelta` for an observation.
- Task-service tests cover a v1 streaming observation becoming `failed` with an explicit error and no tool execution, unchanged final/delta behavior, cancellation winning over an observation, and unchanged v2 deterministic dispatch.
- Observation route tests cover a valid transient response, no-observation response, bounded validation errors, unavailable service, no durable event, no tool request row, no task-state change, and no execution vocabulary.
- OpenAPI and HTTP tests cover `0.7.0`, the exact seventeen-path set, the new capability, response schema fields, and unchanged health API version.
- Repository guardrails cover ADR 0019 status, version/path/capability invariants, parser wiring boundaries, no auto-ledger creation, no executor import, and unchanged dependency baseline.
- Conchbase runs `npm run check`, `npm test`, and `npm run build`. Pagurus runs `npm run check`, `npm test -- --run`, and `npm run build` if its documentation is updated. CI uses deterministic local fixtures; no real credential, user data, public-network call, real model, real tool, or provider SDK is used.
