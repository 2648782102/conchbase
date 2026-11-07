# Decision 0010: First real-model slice, recovery, and composition boundary

Status: **accepted product and internal architecture direction; public contracts are versioned in `docs/openapi.yaml`**

Date: 2026-11-07 (Asia/Shanghai).

## Product direction

Phase 1 connects Conchbase to a real model through the user's local Magpie gateway. Conchbase remains the agent execution authority. Magpie is a replaceable model provider; it does not own task state, policy, approvals, events, or tool execution. CLI, Pagurus, and third-party clients use the same versioned Runtime API.

The first usable slice supports a text task that runs through a single real model turn. It persists task state and ordered events, exposes a task API and CLI, and reports an interrupted task after a process restart. It does **not** implement user-defined agent compositions, model-driven tool execution, MCP servers, Skills loading, plugin hosts, approval UI, secret management, remote binding, or pairing. A single-turn execution unit is an implementation boundary, not a fixed product topology. A layered multi-role arrangement remains only one possible future user configuration; see [ADR 0005](0005-user-defined-agent-topology-proposal.md).

## Evidence and trade-offs

The local Magpie gateway was available on `127.0.0.1:3425` during this slice. Its published [integration documentation](https://usemagpie.ai/docs/integrate) and [getting-started guide](https://usemagpie.ai/docs/start) describe an OpenAI Chat Completions-compatible local endpoint, a model catalog, streaming, tool-call translation, and an app-naming key. A short live request on this machine returned a normal `chat.completion` JSON response with a string `message.content`. These are dated external and local observations; they do not make Magpie a required provider or guarantee that every catalog model has identical behavior.

Magpie's Agents page requires an upstream adapter in Magpie's source; there is no runtime agent-registration API. Conchbase therefore first uses the gateway as one provider. An upstream Magpie adapter is deferred until Conchbase's configuration format is stable. This keeps model access working even when Magpie does not list Conchbase as an agent.

### Model provider

**Decision:** implement a narrow `OpenAiChatCompletionsProvider` that accepts a base URL, a model ID, an optional app-naming key, and an injectable `fetch`. Its `nextTurn` sends one bounded user prompt, validates a non-streaming response, and returns a final answer. It rejects tool-call responses instead of executing them. AbortSignal is forwarded to the request. Provider errors are normalized and must not include response bodies, credentials, or machine-specific paths. The default provider configuration points to the documented Magpie gateway, but tests must use a local fake fetch and never contact a real provider.

Consequences: phase 1 proves a real model call with no provider SDK dependency and no hidden execution path. Provider-specific streaming, multi-turn context, structured tool calls, token limits, and capability discovery remain future conformance work. Direct vendor providers can be added behind the same `ModelAdapter`.

### Task lifecycle and recovery

**Decision:** accept the explicit state machine from [ADR 0002](0002-task-lifecycle-proposal.md) with an additional terminal `interrupted` state. `queued` and `running` can transition to `interrupted`; terminal states reject later transitions. A process restart converts persisted nonterminal records to `interrupted` and appends one `task.interrupted` event. This is a recognition of lost process state, not a continuation of the model call.

**Decision:** `POST /v1/tasks/{taskId}/retry` creates a new `attempt` for a terminal task. The original task ID, configuration revision, and event history remain intact. The new attempt runs from the original prompt; it does not replay model responses, tool calls, or side effects. Cancellation requests on a running task are persisted as `cancelling` and reach `cancelled` when the active call unwinds.

Rationale: a killed process cannot reliably know whether a provider received, processed, or completed a request; replaying it could repeat charges or side effects. Durable events preserve the record and let clients resume observation, while explicit retry makes the new work visible. Automatic continuation would require provider request checkpoints, idempotent tool side effects, and a tested crash-recovery protocol. Those remain out of scope.

### Persistence and event contract

**Decision:** use `node:sqlite` `DatabaseSync` behind a narrow `TaskStore` interface for the first persistence implementation. Store tasks and events in one SQLite transaction with WAL and foreign keys enabled. Sequence numbers and event IDs are monotonic per runtime database; task state and its corresponding event commit together. Driver errors are normalized into runtime errors. On startup, interrupted reconciliation commits with the same transaction boundary.

Consequences: no native npm runtime dependency is added, and local restart behavior is testable. `node:sqlite` remains experimental in Node 24; a future supported-platform CI matrix and migration policy are required before calling the driver a production choice. [ADR 0008](0008-sqlite-driver-compatibility-proposal.md) is evidence, not acceptance of a persistent schema; this ADR accepts only the phase-1 internal schema. Multi-process writers, WAL crash recovery, retention, and schema migrations remain open.

**Decision:** accept the global monotonic event log and ID cursor from [ADR 0003](0003-event-ordering-proposal.md) for phase 1. The public event envelope is `{ sequence, id, taskId, type, state, configurationRevisionId, attempt, data }`; `data` is a bounded JSON object with no credentials. `GET /v1/events?after=<id>` returns persisted events strictly after a known ID; an omitted cursor returns the retained log. Unknown cursors return HTTP 400. Phase 1 uses polling; SSE, `Last-Event-ID`, retention policy, and multi-writer ordering remain open.

### Configuration and public API

**Decision:** accept content-addressed, immutable revision IDs from [ADR 0004](0004-configuration-revision-proposal.md) as the first internal configuration identity. Phase 1 has one active, immutable revision containing only the phase-1 provider reference and policy identifier. It is pinned per task attempt. A public configuration write API, file/profile schema, migrations, rollback, import/export, secret-store interface, and Skill/plugin/MCP bundle format remain open in [ADR 0007](0007-skill-plugin-mcp-configuration-proposal.md). Pagurus must not read or write Conchbase's private SQLite file.

**Decision:** version the new task, event, model catalog, and retry routes in `docs/openapi.yaml`. Keep loopback-only binding. Do not enable remote binding or unauthenticated management until pairing and authentication are designed. The local loopback API remains the only management surface; this is explicitly a local-first development boundary, not an authenticated remote deployment design.

## Scope for the next model

Implement one bounded vertical slice: provider adapter, durable store, orchestration service, HTTP routes, CLI commands, tests, and AI handoff updates. Do not interpret the single-turn loop as an accepted composition schema. Do not expose tool execution or configuration writes from internal primitives. Keep implemented behavior and roadmap separate in all documentation.

## Validation

- Deterministic unit tests cover provider response parsing, provider error normalization, cancellation, task transitions, event replay, and atomic task/event persistence using temporary databases and a fake `fetch`.
- Integration tests use Fastify injection with temporary databases; no public network call or real credential is used in `npm test`.
- Live Magpie calls are manual, opt-in CLI/API operations using the user's already configured local gateway; they are not part of CI.
- Restart tests assert nonterminal tasks become `interrupted`, event cursors still replay, and explicit retry creates a new attempt without deleting history.
- Repository guardrails evolve in the same slice to check the accepted contracts instead of the old read-only scaffold boundary.
