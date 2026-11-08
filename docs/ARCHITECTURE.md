# Conchbase architecture

## Runtime boundary

Conchbase is the execution authority. It owns task state, model calls, cancellation, explicit retry, durable events, and the phase-1 configuration revision. Pagurus and third-party clients use the versioned Runtime API. The phase-1 CLI takes short-lived private database ownership under [ADR 0011](decisions/0011-phase-one-database-instance-ownership.md). No UI is required to start or finish a task.

User-defined agent composition is intended to be topology-neutral. A layered multi-role setup is only an illustrative example and must not become a built-in structure, default template, required layer count, or role-name convention. Phase 1 implements a single-turn execution unit to validate real-model execution; this is not an accepted composition schema. See [ADR 0005](decisions/0005-user-defined-agent-topology-proposal.md) and [ADR 0010](decisions/0010-first-real-model-slice.md).

```text
CLI ────────────┐
Pagurus ────────┼── versioned Runtime API ── Conchbase TaskService
External clients┘                              ├─ OpenAiChatCompletionsProvider (streaming)
                                               │    └── local Magpie gateway
                                               └─ TaskStore
                                                    └── node:sqlite tasks + events
```

## Interface rules

- HTTP/JSON is the management and task API. `docs/openapi.yaml` is the versioned source of truth.
- Events have stable global sequence numbers and IDs so clients can poll from a cursor after reconnecting. `task.output_delta` events carry bounded answer-text chunks. SSE remains a later compatibility concern.
- Magpie is a replaceable local model gateway. Its OpenAI Chat Completions endpoint, model catalog, and app-naming key are provider details behind the adapter; they do not become public Conchbase schemas.
- `GET /v1/configuration`, revision reads, `POST /v1/configuration/validate`, and `POST /v1/configuration/apply` expose the versioned `schemaVersion: 1` document contract. Configuration references are opaque data; no public route installs, enables, grants, loads, or executes a capability. See [ADR 0014](decisions/0014-versioned-configuration-api.md).
- Browser clients connect through the same-origin development proxy or an explicitly paired future endpoint. The runtime binds to loopback by default.

## Phase-1 execution flow

1. A client sends `POST /v1/tasks` with a prompt and optional model id. `TaskService.createTask` validates it and `TaskStore.createTask` atomically inserts a `queued` task and its first event.
2. `TaskService.startTask` tracks an `AbortController` and runs `OpenAiChatCompletionsProvider.streamTurn`. The provider sends one `stream: true` request to Magpie's `/v1/chat/completions`; the non-streaming `nextTurn` remains an internal acceptance adapter.
3. Each answer-text chunk updates `partialOutput` and commits one `task.output_delta` event atomically. Reasoning text is ignored and tool-call deltas are rejected. Task state changes and their events are committed together. A completion becomes `succeeded` with final output; a normalized provider error becomes `failed`; cancellation becomes `cancelling` then `cancelled`. `partialOutput` is cleared on terminal states and retry.
4. On process startup, `TaskService` converts persisted nonterminal states to `interrupted` and records one event per task. It never replays an in-flight provider call.
5. `POST /v1/tasks/{taskId}/retry` creates a new attempt from the original prompt while preserving the task ID and all previous events.

The internal `src/runtime/task-runner.ts` and `policy-gate.ts` remain deterministic acceptance primitives for a future tool-capable loop. `src/runtime/tool-capability.ts` adds an internal, fixture-only `ToolRegistry` and `ToolCapabilityKernel` with exact versioned approvals, per-attempt idempotency, bounded audit scalars, and replayable normalized failures. These modules are not wired into the phase-1 HTTP task path, do not emit durable SQLite events, and do not execute real host tools. Tool-prefixed event names in the internal lifecycle union are deterministic test vocabulary only; `docs/openapi.yaml` `0.4.0` remains the public event contract. See [ADR 0013](decisions/0013-bounded-tool-capability-kernel.md).

`src/runtime/composition-document.ts` is an internal identity kernel under [ADR 0015](decisions/0015-composition-identity-kernel.md). It validates arbitrary topology-neutral directed acyclic graphs, canonicalizes user-authored nodes and links, and computes a `cmp_` identity. It has no public route, configuration schema section, persistence, executor, capability grant, or scheduling semantics. Its current acyclicity and entry-set rules are deterministic fixture structure rules. A public composition contract must define execution order, concurrency, delegation, cancellation propagation, and tool audit scope separately.

## State and configuration

- `SqliteTaskStore` owns normalized task, `partialOutput`, event, configuration revision, and active-pointer rows in one private SQLite database. WAL and foreign keys are enabled; an exclusive SQLite lock rejects a second simultaneous owner with a normalized `DatabaseInstanceError`. This is a single-owner development boundary from [ADR 0011](decisions/0011-phase-one-database-instance-ownership.md), not multi-process support or a production recovery matrix. Driver types and errors do not leave the store boundary.
- `MagpieModelCatalog` reads the local model list without opening the runtime database, so `conchbase models` can run while the HTTP service owns tasks. Other task-state CLI commands take short-lived database ownership and must not overlap `conchbase serve`.
- A content-addressed, immutable revision identifies the active configuration. Each task attempt pins its revision id. Portable profile files, secret resolution, and capability lifecycle schemas are not implemented.
- The active configuration revision comes from durable `configuration_state`. Applying a document appends an immutable content-addressed revision if new; rollback changes only the pointer. Existing tasks keep their pinned id. The document carries bounded opaque references, not a topology, installation state, grant, or secret value.
- Artifacts, secrets, MCP servers, Skills, approvals, and plugin hosts are not implemented. Provider credentials stay in Magpie's own configuration; Conchbase sends only the optional `magpie-<app-id>` naming key.
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
    ├── task-service.ts             # orchestration, cancellation, retry, recovery
    ├── task-store.ts               # SQLite task/event/configuration persistence interface
    ├── configuration-document.ts   # versioned public document validation and identity
    ├── composition-document.ts     # internal topology-neutral composition identity
    ├── event-log.ts                # deterministic in-memory event invariants
    ├── task-lifecycle.ts           # state machine
    ├── task-runner.ts              # provider-independent tool-loop acceptance harness
    ├── policy-gate.ts              # tool policy primitive
    ├── tool-capability.ts          # internal fixture-only capability kernel
    └── configuration-revision.ts   # content-addressed revision identity
```

Keep domain rules independent of Fastify, provider HTTP, and SQLite. Add a module only when a real capability or security boundary needs an owner.
