# Decision 0012: Streaming model output and durable progress events

Status: **accepted product and public API direction; contracts are versioned in `docs/openapi.yaml`**

Date: 2026-11-07 (Asia/Shanghai).

## Context

[ADR 0010](0010-first-real-model-slice.md) accepts one non-streaming text turn with final output persisted only when the model finishes. Clients can poll task state, but they cannot show visible progress before the terminal event. [ADR 0011](0011-phase-one-database-instance-ownership.md) keeps one SQLite owner, so a durable event log remains the authoritative stream for CLI, Pagurus, and third-party clients.

Magpie's [integration documentation](https://usemagpie.ai/docs/integrate) states that its OpenAI Chat Completions endpoint translates streaming, tool calls, images, and reasoning. A dated local request on this machine to `stream: true` returned `text/event-stream` chunks with `choices[0].delta.content`, optional `choices[0].delta.reasoning_content`, optional `delta.tool_calls`, a `finish_reason`, and a final `[DONE]` frame. Some providers emit reasoning text separately from answer text; that reasoning text is untrusted provider detail and must not become a Conchbase public contract.

The task queue calls for provider streaming and visible progress. It also requires an accepted ADR before a public contract changes. SSE transport, `Last-Event-ID`, retention, and multi-writer ordering remain open.

The Magpie observations below justify the current compatibility implementation only. Durable output-delta events and task progress are Conchbase contracts; they must not require Magpie-specific event fields or imply that Magpie is the only provider. A future adapter can expose equivalent bounded answer text through the provider boundary while preserving those runtime semantics.

## Options

### A. Continue polling task state only

Keep one non-streaming provider request and show a generic "running" indicator in clients.

Consequences: no API or persistence change, but users see no output until the whole response arrives. It leaves the next queue item unresolved. Rejected.

### B. Durable output-delta events with a versioned task field (recommended)

Send `stream: true` through the narrow Magpie adapter, parse only answer-text `delta.content` chunks, and normalize each chunk into a `task.output_delta` event. Add bounded fields to the existing event `data` object: `delta` (the text chunk), `index` (a zero-based per-attempt chunk counter), and `outputLength` (the accumulated answer length after this chunk). Persist the accumulated answer as `partialOutput` on the task without leaving `running` state. On a normal finish, commit `task.completed` with the accumulated final output. Keep polling `/v1/events` and `/v1/tasks` as the only client transports.

Consequences: progress is replayable from a cursor, survives reconnects, and remains available to any client without a browser-only stream. The persisted task record gains one optional nullable field, `partialOutput`, whose meaning is tied to `running` and `cancelling`. It is cleared on retry and on terminal success/failure/cancellation. A provider that emits many tiny chunks creates many SQLite transactions, so chunk size and total output need explicit bounds. This does not implement SSE, reasoning display, multi-turn context, structured tool calls, or model-driven tool execution.

### C. Add an SSE endpoint now

Expose provider tokens over `text/event-stream` and let clients maintain their own transient buffers.

Consequences: lower latency in a live browser, but it settles `Last-Event-ID`, retention, replay, reconnect semantics, and authorization behavior before those decisions are accepted. It also creates a second event representation next to the durable event log. Rejected for this slice; polling remains the compatibility baseline.

## Decisions

1. **Provider boundary.** Extend `OpenAiChatCompletionsProvider` with an explicit streaming turn that accepts an `onOutputDelta` callback. Keep non-streaming `nextTurn` and its deterministic fixtures unchanged for internal acceptance harnesses. The HTTP task path uses the streaming turn. The provider must use an injectable `fetch`, forward `AbortSignal`, accept `text/event-stream` or a compatible stream content type, parse `data:` frames up to `[DONE]`, reject malformed JSON, reject tool-call deltas, ignore `reasoning_content`, and normalize provider errors without response bodies or credentials.
2. **Progress event.** Add `task.output_delta` to the accepted event type vocabulary. Its event state is `running`; it does not change task state. Each event has a globally monotonic ID and sequence from [ADR 0003](0003-event-ordering-proposal.md), pins the task's configuration revision and attempt, and carries only bounded JSON scalars in `data`. A delta event is committed after the task's `partialOutput` in the same SQLite transaction.
3. **Task contract.** Add `partialOutput: string | null` to `Task`. It is `null` for a queued task, visible non-final text while `running` or `cancelling`, and `null` in terminal states. `output` remains the authoritative final answer. OpenAPI document version becomes `0.3.0`; the health API version remains `1`. `/v1/runtime` advertises `streaming-output`.
4. **Terminal behavior.** A normal `finish_reason` with non-empty accumulated text becomes `succeeded`. An empty stream becomes `failed` with a normalized error. A transport error becomes `failed`. Cancellation aborts the provider request; already-committed delta events remain in history, the task becomes `cancelled`, and `partialOutput` is cleared. A process restart still marks nonterminal tasks `interrupted` and clears `partialOutput`; explicit retry creates a new attempt from the original prompt and resets the chunk index. Never resume an in-flight provider request.
5. **Limits.** Reject an individual provider chunk over 4000 characters, accumulated output over 100000 characters, or more than 5000 delta chunks per attempt. These are phase-1 bounds, not a product token-limit contract. `task.output_delta.data` mirrors the bounded chunk only; clients reconstruct by reading ordered events or use `partialOutput` as the current authoritative snapshot.
6. **Non-goals.** No SSE route, `Last-Event-ID`, reasoning/thinking display, tool execution, approvals, streaming structured tool calls, provider capability discovery, token accounting, direct vendor adapters, configuration writes, or remote binding.

## Consequences

The public API changes additively: task reads gain one field and event polling can return a new event type. Existing clients that validate exact task keys must update their validators; Conchbase and Pagurus are updated in the same slice. The new field and event are documented in `docs/openapi.yaml`, `docs/API.md`, and the AI handoff. Repository guardrails are updated alongside this ADR to check the accepted `0.3.0` route contract and prevent accidental tool execution from streaming deltas.

Durable per-chunk commits favor correctness and replay over maximum throughput. If a provider emits very small chunks, future work can add bounded coalescing after a documented event-batching ADR. Storage retention and migrations remain open.

## Validation

- Fake `fetch` streaming fixtures cover SSE frame parsing, multiple `data:` lines, `[DONE]`, ignored reasoning text, tool-call rejection, empty output, malformed JSON, HTTP errors, cancellation during streaming, and phase-1 size/count limits.
- Task-service tests assert ordered delta events, monotonic indices/output lengths, `partialOutput` while active, final `output`, cleared `partialOutput` on terminal states, cancellation history, restart interruption, and retry with a fresh index.
- HTTP/OpenAPI tests cover the new task field, event data shape, runtime capability, loopback URL, and the exact accepted path set.
- Pagurus validates `partialOutput`, displays visible progress while polling, and keeps final `output` authoritative after a terminal state.
- CI uses no real credentials, personal data, public-network calls, or live model provider. A separate local manual smoke may use the user's already running Magpie gateway.
