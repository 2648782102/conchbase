# Conchbase architecture

## Runtime boundary

Conchbase is the execution authority. It owns Agent identity and revisions, task state/bindings, model calls, composition dispatch for legacy tasks, cancellation, explicit retry, durable events, and versioned runtime configuration revisions. Pagurus and third-party clients use the versioned Runtime API. The phase-1 CLI takes short-lived private database ownership under [ADR 0011](decisions/0011-phase-one-database-instance-ownership.md). No UI is required to start or finish a task.

User-defined agent composition is topology-neutral. A layered multi-role setup is only an illustrative example and must not become a built-in structure, default template, required layer count, or role-name convention. A `schemaVersion: 1` task uses one streaming model turn; a `schemaVersion: 2` task uses a bounded deterministic composition executor. Neither is a general multi-agent scheduling product. See [ADR 0005](decisions/0005-user-defined-agent-topology-proposal.md), [ADR 0010](decisions/0010-first-real-model-slice.md), and [ADR 0016](decisions/0016-composition-execution-and-public-schema.md).

[ADR 0022](decisions/0022-persistent-work-runtime-direction.md) accepts the direction of durable, event-driven, topology-neutral work. [ADR 0024](decisions/0024-durable-work-domain-and-public-api.md) implements the first `Source / Trigger / Thread / Mandate / WorkItem / Assignment / Outbox / DeliveryReceipt` contract above the unchanged phase-1 `Task` resource: pure domain validation, `SqliteWorkStore` behind one database owner, four `/v1/work` routes, and additive `user_version = 2` tables. It remains deterministic and execution-free. [ADR 0023](decisions/0023-secret-handle-and-runtime-injection-proposal.md) proposes a private SecretHandle registry and a runtime-owned fixed-destination injector; no plaintext may cross the model, UI, event, log, or error boundary. The diagram below is the implemented `0.9.0` architecture, not a roadmap diagram.

```text
CLI ────────────┐
Pagurus ────────┼── versioned Runtime API ── Conchbase TaskService
External clients┘                              ├─ OpenAiChatCompletionsProvider (v1 streaming)
                                               │    └── local Magpie gateway
                                               │    └── transient whole-message tool-call observation
                                               ├─ Agent profiles/revisions + provider-neutral catalog
                                               ├─ Agent task binding (one turn, immutable pin)
                                               ├─ CompositionExecution (legacy v2 deterministic)
                                               ├─ ToolRequestLedger (public records, no executor)
                                               ├─ ProviderObservationRoute (transient normalization)
                                               ├─ WorkRoutes (deterministic intake and reads)
                                               └─ TaskStore
                                                    ├── node:sqlite tasks + events + revisions + tool requests
                                                    └── SqliteWorkStore work_* tables (same DatabaseSync handle)
```

## Interface rules

- HTTP/JSON is the management and task API. `docs/openapi.yaml` is the versioned source of truth. `POST /v1/work/triggers` parses its raw `application/json` body for its own route scope so `parseWorkTriggerRequest` can reject unknown fields; Fastify's default JSON body handling remains in force for all other routes.
- Events have stable global sequence numbers and IDs so clients can poll from a cursor after reconnecting. `task.output_delta` events carry bounded answer-text chunks; composition events carry bounded node identity. SSE remains a later compatibility concern.
- Magpie is a replaceable local model gateway. Its OpenAI Chat Completions endpoint, model catalog, and app-naming key are provider details behind the adapter; they do not become public Conchbase schemas.
- `GET /v1/configuration`, revision reads, `POST /v1/configuration/validate`, and `POST /v1/configuration/apply` expose the versioned `schemaVersion: 1` and `schemaVersion: 2` document union. Configuration references are opaque data; no public route installs, enables, grants, loads, or executes a capability. See [ADR 0014](decisions/0014-versioned-configuration-api.md) and [ADR 0016](decisions/0016-composition-execution-and-public-schema.md).
- Browser clients connect through the same-origin development proxy or an explicitly paired future endpoint. The runtime binds to loopback by default.

## Execution flow

1. A client sends `POST /v1/tasks` with a prompt and optional model id. `TaskService.createTask` validates it, pins the active configuration revision, and `TaskStore.createTask` atomically inserts a `queued` task and its first event.
2. `TaskService.startTask` tracks an `AbortController` and reads the pinned immutable configuration revision. A v1 revision runs `OpenAiChatCompletionsProvider.streamTurn`; the provider sends one `stream: true` request to Magpie's `/v1/chat/completions`. A v2 revision runs `composition-execution.ts` without a model call.
3. For v1, each answer-text chunk updates `partialOutput` and commits one `task.output_delta` event atomically. Reasoning text is ignored and tool-call deltas are rejected. One whole message-shaped non-streaming function tool call becomes a transient observation; `TaskService` fails visibly with an observation-not-actionable error and creates no ledger request or tool execution. For v2, composition events carry node identity and the pinned `cmp_` graph id in bounded `data` scalars. Task state changes and their events are committed together. A completion becomes `succeeded` with final output; a normalized provider or executor error becomes `failed`; cancellation becomes `cancelling` then `cancelled`. `partialOutput` is cleared on terminal states and retry.
4. On process startup, `TaskService` converts persisted nonterminal states to `interrupted` and records one event per task. It never replays an in-flight provider call or automatically continues a composition.
5. `POST /v1/tasks/{taskId}/retry` creates a new attempt from the original prompt and the original pinned configuration revision while preserving the task ID and all previous events.

The internal `src/runtime/task-runner.ts` and `policy-gate.ts` remain deterministic acceptance primitives for a future tool-capable loop. `src/runtime/tool-capability.ts` adds an internal, fixture-only `ToolRegistry` and `ToolCapabilityKernel` with exact versioned approvals, per-attempt idempotency, bounded audit scalars, and replayable normalized failures. These modules are not wired into the HTTP task path, do not emit durable SQLite events, and do not execute real host tools. `src/runtime/tool-request.ts` is a separate public provider-neutral ledger boundary: `TaskService` uses it to derive composition-scoped identity, validate normalized tool call proposals, and emit durable request/decision events. It never imports `ToolCapabilityKernel` and never calls an executor. Public ledger events are `tool.requested`, `tool.approval_required`, `tool.approved`, and `tool.rejected`; `tool.executed`, `tool.failed`, `tool.denied`, and `tool.replayed` remain internal deterministic-test vocabulary. `docs/openapi.yaml` `0.6.0` is the public event contract. See [ADR 0013](decisions/0013-bounded-tool-capability-kernel.md) and [ADR 0017](decisions/0017-public-tool-request-approval-ledger.md).

`src/runtime/provider-tool-call.ts` is a pure, internal ADR 0018 parsing boundary for one OpenAI Chat Completions-compatible non-streaming function tool call. ADR 0019 wires it into `OpenAiChatCompletionsProvider` and `POST /v1/provider-observations/tool-calls`. It reuses `ToolCallProposal` and the `arg_` digest and returns a transient normalized observation. It is not imported by `TaskService`, `SqliteTaskStore`, or `ToolCapabilityKernel`; the task path does not auto-create a ledger request or execute a tool. Streaming tool-call accumulation and execution remain separate accepted slices.

`src/runtime/composition-document.ts` is the internal identity kernel under [ADR 0015](decisions/0015-composition-identity-kernel.md). `src/runtime/configuration-document.ts` exposes its user-authored fields as the public `schemaVersion: 2` composition section. `src/runtime/composition-execution.ts` derives deterministic node order, terminal ids, `cmp_` identity, and bounded output. [ADR 0016](decisions/0016-composition-execution-and-public-schema.md) defines the accepted public graph representation, node events, and cancellation propagation; general concurrency, delegation, model-driven node work, and tool audit scope remain open.

## Agent resource and task binding

ADR 0020 publishes runtime-local Agent resources with immutable opaque revision IDs, bounded instructions, and provider-neutral model references. Agent profile history is independent from the one global runtime-wide policy/capability configuration revision. Agent-backed tasks atomically pin Agent ID/revision, runtime configuration revision, and effective provider/model with the queued event. A task rechecks the revision it validated against during provider catalog lookup to avoid binding an unvalidated concurrent edit. Retries use the same pin even when the Agent is archived. Legacy tasks keep their previous request contract and global v1/v2 dispatch; Agent tasks make one model turn and do not implicitly run the global deterministic composition. Instructions are untrusted customization context and do not grant tools.

## State and configuration

- `SqliteTaskStore` owns normalized task, `partialOutput`, event, configuration revision, tool request, and active-pointer rows in one private SQLite database. WAL and foreign keys are enabled; an exclusive SQLite lock rejects a second simultaneous owner with a normalized `DatabaseInstanceError`. This is a single-owner development boundary from [ADR 0011](decisions/0011-phase-one-database-instance-ownership.md), not multi-process support or a production recovery matrix. Driver types and errors do not leave the store boundary.
- Startup runs the additive Agent and durable-work migrations under one exclusive transaction and marks them with `PRAGMA user_version = 2`. The migration adds nullable task/event Agent identity columns, new Agent tables, and eight `work_*` tables while preserving existing rows and active configuration state. `SqliteWorkStore` shares `SqliteTaskStore`'s `DatabaseSync` handle; it never opens a second owner.
- `MagpieModelCatalog` reads the local model list without opening the runtime database, so `conchbase models` can run while the HTTP service owns tasks. Other task-state CLI commands take short-lived database ownership and must not overlap `conchbase serve`.
- A content-addressed, immutable revision identifies the active configuration. Each task attempt pins its revision id. Portable profile files, secret resolution, and capability lifecycle schemas are not implemented.
- The active configuration revision comes from durable `configuration_state`. Applying a document appends an immutable content-addressed revision if new; rollback changes only the pointer. Existing tasks keep their pinned id. v1 documents carry bounded opaque references; v2 documents also carry user-authored topology-neutral composition data. Neither version stores installation state, grants, or secret values.
- Artifacts, secrets, MCP servers, Skills, executable tool approvals, execution results, and plugin hosts are not implemented. The public tool request/approval ledger stores digest-only records and audit events, not side effects. Provider credentials stay in Magpie's own configuration; Conchbase sends only the optional `magpie-<app-id>` naming key.
- The phase-1 database schema has no migration policy or cross-platform production guarantee. See the open decisions in `docs/AI_HANDOFF.md`.

## Source layout

```text
src/
├── cli.ts                         # CLI commands and direct runtime use
├── main.ts                        # server entry point
├── config/runtime-config.ts       # environment parsing and loopback validation
├── http/
│   ├── create-app.ts               # Fastify construction and route registration
│   └── routes/v1/                  # versioned HTTP route handlers
└── runtime/
    ├── magpie-provider.ts          # real local streaming/non-streaming adapter
    ├── model-catalog.ts            # database-free local model discovery
    ├── agent-profile.ts            # provider-neutral Agent profile and identity types
    ├── task-service.ts             # Agent orchestration, cancellation, retry, recovery, v1/v2 dispatch
    ├── task-store.ts               # SQLite task/event/Agent/configuration persistence and migration
    ├── configuration-document.ts   # public v1/v2 document validation and identity
    ├── composition-document.ts     # internal topology-neutral composition identity
    ├── composition-execution.ts    # deterministic topology-neutral composition plan
    ├── provider-tool-call.ts       # pure non-streaming provider tool-call parser
    ├── tool-request.ts             # public normalized tool request/approval ledger boundary
    ├── event-log.ts                # deterministic in-memory event invariants
    ├── task-lifecycle.ts           # state machine
    ├── task-runner.ts              # provider-independent tool-loop acceptance harness
    ├── policy-gate.ts              # tool policy primitive
    ├── tool-capability.ts          # internal fixture-only capability kernel
    └── configuration-revision.ts   # content-addressed revision identity
```

Keep domain rules independent of Fastify, provider HTTP, and SQLite. Add a module only when a real capability or security boundary needs an owner.
