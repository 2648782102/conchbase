# AI development handoff: Conchbase

> **AI-first project:** Conchbase is developed primarily by AI coding agents. Optimize the repository for fast, accurate agent context loading, bounded changes, and deterministic validation; human handoff is not a product requirement. Keep implementation explicit, typed, and easy to inspect. Start with `AGENTS.md`, then follow this handoff.

This document is the starting packet for a coding model that has not seen the design conversation. It describes repository facts and accepted boundaries; roadmap items are not implemented features.

## Product definition

Conchbase (海螺) is a local-first, headless-capable personal agent runtime. It owns the agent execution loop and can run from a CLI without Pagurus or another graphical interface. Pagurus is an optional control client. Other clients should be able to connect through a stable, documented API. Target users are open-ended; CLI, GUI, and third-party integrations are all valid clients.

The paired product direction is a user-managed collection of independently customizable Agents through clients such as Pagurus, with Conchbase authoritative for identity, immutable profile revisions, task bindings, model execution, task state, and permissions. ADR 0020 and the 0.8.0 Runtime API implement that vertical slice. The v1/v2 configuration remains one separate runtime-wide policy/capability revision with opaque references and optional topology data. Agent-backed tasks pin their Agent revision, runtime configuration revision, and effective provider/model; retries preserve them. Agent tasks use one model turn, while legacy tasks keep their prior v1/v2 dispatch. Provider choice is represented provider-neutrally. Magpie is one compatibility adapter, not the product destination.

Users can later define highly customizable Agent compositions through a versioned, topology-neutral configuration section. A layered arrangement with several specialized roles is an illustrative example, not a built-in structure, default template, required hierarchy, or scheduling policy. [ADR 0016](decisions/0016-composition-execution-and-public-schema.md) accepts one bounded public graph representation and a deterministic execution rule, not model-driven multi-agent work. The broader user-defined composition product remains open: model-driven node work, delegation, concurrency, role registries, and coordination patterns are not implemented. See [ADR 0005](decisions/0005-user-defined-agent-topology-proposal.md).

## Read in this order

1. `AGENTS.md` — mandatory coding constraints and AI-first development rule.
2. This handoff, then `docs/AI_DEVELOPMENT.md`.
3. [ADR 0010](decisions/0010-first-real-model-slice.md) — accepted phase-1 direction, trade-offs, and explicit non-goals.
4. [ADR 0011](decisions/0011-phase-one-database-instance-ownership.md) — accepted phase-1 single-instance persistence boundary.
5. [ADR 0012](decisions/0012-streaming-output-progress.md) — accepted streaming progress contract and non-goals.
6. [ADR 0013](decisions/0013-bounded-tool-capability-kernel.md) — accepted internal tool capability kernel; no public tool execution.
7. [ADR 0014](decisions/0014-versioned-configuration-api.md) — accepted `0.4.0` `schemaVersion: 1` configuration document.
8. [ADR 0015](decisions/0015-composition-identity-kernel.md) — accepted internal topology-neutral composition identity and sequencing.
9. [ADR 0016](decisions/0016-composition-execution-and-public-schema.md) — accepted `0.5.0` v1/v2 configuration union, deterministic composition execution, node events, and cancellation.
10. [ADR 0017](decisions/0017-public-tool-request-approval-ledger.md) — accepted `0.6.0` public tool request/approval ledger; durable audit, no tool execution.
11. [ADR 0018](decisions/0018-provider-tool-call-parsing-boundary.md) — accepted internal provider tool-call parser; no execution and no public API change.
12. [ADR 0019](decisions/0019-explicit-provider-tool-call-observation-boundary.md) — accepted `0.7.0` explicit provider observation boundary; transient normalization, no auto-ledger, no execution.
13. [ADR 0020](decisions/0020-multi-agent-and-provider-neutral-model-contract.md) — accepted Agent resource, provider-neutral catalog, task binding, and additive migration.
14. [ADR 0021](decisions/0021-cross-repository-paired-runtime-acceptance.md) — accepted deterministic live loopback acceptance boundary; no public API contract change.
15. `docs/ARCHITECTURE.md` — runtime and client boundaries plus current source layout.
16. `docs/API.md` and `docs/openapi.yaml` — the versioned API source of truth.
17. `docs/TECH_STACK.md` — chosen and deferred technology.
18. `docs/ROADMAP.md`, `docs/REFERENCE_PROJECTS.md`, and proposal ADRs `0002`–`0008` — wider intended sequencing and still-open contracts.
19. `docs/AI_TASK_QUEUE.md` — bounded work for the next coding model.

## Current repository facts

Implemented:

- Node.js 24+ and TypeScript application, Fastify loopback API, and a `conchbase` CLI.
- Phase 1 currently connects a real model through the Magpie compatibility adapter's local OpenAI Chat Completions-compatible gateway. A `schemaVersion: 1` task uses one streaming request with a narrow adapter, injectable `fetch`, an `AbortSignal`, and normalized errors; it ignores reasoning text, returns one whole message-shaped tool call as a transient observation that fails visibly, rejects streaming tool-call deltas and unsupported shapes, and never executes a tool. This describes the implemented adapter, not an exclusive provider requirement.
- `POST /v1/tasks` creates and starts one bounded task; `GET /v1/tasks` and `GET /v1/tasks/{taskId}` read persisted task state. `POST .../cancel` and `POST .../retry` expose cancellation and explicit retry.
- `GET /v1/models` currently reads the Magpie compatibility catalog. The future Agent model reference and discovery contract must be provider-neutral and must not embed this catalog's implementation-specific ids or response shape. `GET /v1/events?after=<eventId>` reads durable, globally ordered events. See `docs/openapi.yaml` and `docs/API.md`.
- `GET /v1/model-catalog` exposes provider-neutral `{ providerId, modelId }` entries. `magpie` is the only currently registered provider adapter; this compatibility implementation does not define the Agent model schema.
- `/v1/agents` and related routes provide runtime-local create/list/read/update/duplicate/archive/default/revision operations. Updates require the expected revision. Archive preserves history and clears the default when needed.
- `/v1/tasks` accepts either the legacy `{ prompt, model? }` shape or `{ prompt, agentId, modelOverride? }`. Agent tasks pin their immutable definition, active runtime configuration revision, and effective provider/model with the queued event; they run one streaming model turn regardless of the global v1/v2 configuration. Legacy tasks keep their established behavior. Retrying an archived Agent task uses its pinned revision.
- Answer-text chunks from a v1 task become durable `task.output_delta` events with per-attempt `index` and `outputLength`; `GET /v1/tasks/{taskId}` exposes the current `partialOutput` while a task is active. Final `output` remains authoritative and `partialOutput` is cleared on terminal states. Polling is the client transport; there is no SSE route yet.
- Tasks, attempts, outputs, errors, and events are persisted by `SqliteTaskStore` using Node 24's built-in `node:sqlite` `DatabaseSync`. Task state and its event commit in one transaction. WAL and foreign keys are enabled.
- `SqliteTaskStore` holds a SQLite exclusive lock for the database and normalizes a second owner to `DatabaseInstanceError`. This is a single-owner development boundary, not multi-process support or a production recovery matrix. `conchbase models` currently uses a standalone `MagpieModelCatalog` compatibility implementation and does not open the runtime database; future provider-neutral discovery must preserve database-free behavior where appropriate without making Magpie the domain contract.
- A process restart marks nonterminal tasks as `interrupted`. It does not resume an in-flight model call. An explicit retry creates a new attempt from the original prompt, keeps the original pinned configuration revision, and preserves previous events.
- Public configuration documents are versioned data. `schemaVersion: 1` keeps the ADR 0014 opaque-reference contract; `schemaVersion: 2` adds a required topology-neutral `composition` section. Both versions are persisted as content-addressed immutable revisions in the same private SQLite database. All document sections, including `metadata`, are required; `source: url` is not accepted. References do not install, enable, grant, resolve secrets, load code, or execute tools.
- `/v1/configuration` reads the active revision; `/v1/configuration/revisions` lists history; `/v1/configuration/validate`, `/v1/configuration/apply`, and rollback by `rollbackTo` are implemented. The exact OpenAPI path set is twenty-five routes, including Agent resources, provider-neutral model discovery, three public tool request/approval ledger routes, and one transient provider observation route.
- Every task attempt pins the active configuration revision at creation. Applying or rolling back a revision affects later tasks only; existing task rows and events retain their original pinned id. A v2 task runs from its pinned immutable revision even after later configuration changes.
- `PRAGMA user_version = 1` marks the additive Agent migration. Under the exclusive startup transaction, nullable Agent identity columns are added to existing tasks/events and Agent tables are created. Legacy task/event/tool-request/configuration rows and the active pointer remain intact; failures roll back the migration.
- Agent revision identifiers are immutable opaque ids. Concurrent edit and task creation use expected-revision comparison inside the SQLite write transaction.
- A `schemaVersion: 2` task runs a deterministic, topology-neutral composition executor. It computes a `cmp_` identity from the pinned graph, traverses one deterministic topological order, emits composition node events, checks cancellation before and during each node, and writes a deterministic final output. It makes no model-provider call, emits no `task.output_delta`, never executes a model-requested or real host tool, and never loads a Skill/MCP/plugin. Single-node, chain, fan-out/fan-in, and multiple-entry DAGs are deterministic fixtures.
- Composition events keep the public event envelope unchanged and carry bounded scalars in `data`: `compositionDocumentId`, `compositionNodeId`, `nodeIndex`, `nodeCount`, `completedNodeCount`, and `terminalNodeIds`. The event envelope also carries the pinned `configurationRevisionId` and `attempt`.
- An internal `ToolCapabilityKernel` provides an immutable fixture-only registry, exact versioned approval records, per-attempt idempotency keys, bounded audit scalars, and replayable normalized executor failures. Its tool-prefixed event names are internal deterministic-test vocabulary. It is not imported by the HTTP task path, is not persisted by `SqliteTaskStore`, and does not execute real host tools.
- A public, provider-neutral tool request/approval ledger accepts normalized tool call proposals for eligible `schemaVersion: 2` task attempts in `queued`, `running`, or `waiting_approval`. `POST /v1/tool-requests`, `GET /v1/tool-requests/{requestId}`, and `POST /v1/tool-requests/{requestId}/approval` persist one versioned request, a composition-scoped idempotency key, and one explicit approval or rejection. Requests store only an arguments digest; approvals store only a reason digest. Creation and decision events are durable through `GET /v1/events`, but no tool is executed and no task state transition occurs. The public ledger does not import `ToolCapabilityKernel`.
- `src/runtime/provider-tool-call.ts` is the internal, pure parser for one OpenAI Chat Completions-compatible non-streaming function tool call. ADR 0019 wires it into `OpenAiChatCompletionsProvider.nextTurn`, one whole message-shaped tool call in `OpenAiChatCompletionsProvider.streamTurn`, and the transient `POST /v1/provider-observations/tool-calls` route. It returns a frozen `version: 1` observation with a provider tool-call id, the accepted `ToolCallProposal`, and an `arg_` arguments digest. It rejects streaming deltas, mixed answers, multiple calls, malformed or sensitive fields, and non-scalar arguments. `TaskService` does not create a ledger request or execute a tool from an observation; a v1 streaming observation fails visibly. No durable observation table, public event, configuration schema, executor, or task transition is added.
- Automated tests cover provider parsing and failures, transient observation routes, task completion, durable event replay, restart interruption, explicit retry, v1/v2 configuration validation/history/rollback/pinning, composition execution and cancellation, HTTP error behavior, loopback configuration, the internal task runner, policy gate, and deterministic repository guardrails. Tests use fake `fetch` and temporary databases; CI does not call a model provider.
- ADR 0021 adds deterministic live loopback paired-runtime acceptance. `tests/agent-paired-runtime.test.ts` starts a fake Magpie-compatible gateway and the real Fastify Runtime, maps Pagurus's relative `/v1/...` client fetches over HTTP, dynamically imports the published Pagurus clients, and verifies two independent Agents, revision pins, stale writes, configuration apply/rollback, archive/default/override, cancellation, restart interruption, retry, event replay, legacy task dispatch, deterministic v2 composition, streaming, and CLI compatibility. The test skips only when the optional nested Pagurus checkout is absent. It uses no real model credential, public-network call, or private database access from Pagurus.
- GitHub Actions runs `npm run check`, `npm test`, and `npm run build`.

Not implemented yet:

- Model-driven composition nodes, role registry, multi-turn model context, streaming tool-call accumulation, model-driven tool execution, public tool execution API, real executor isolation, crash-safe side effects, MCP client, Skills loader, install/enable/grant operations, secret resolution, portable file import/export, production approval workflow, plugin host, memory, artifacts, SSE event stream, reasoning display, event retention policy, production driver compatibility matrix, authentication/pairing, or remote binding.
- A Magpie upstream Agents-page adapter. Magpie currently requires such an adapter in its own source; Conchbase phase 1 uses the local gateway directly.

Do not describe planned features as implemented. Do not describe the phase-1 single-turn loop or the bounded v2 deterministic executor as a general multi-agent scheduling product.

## Accepted architectural boundaries

- Conchbase is the agent execution authority. It owns task state, provider calls, composition dispatch, the narrow model adapter boundary, persisted state, and the authoritative event log.
- Pagurus and other external clients use the public Runtime API and never read or write private runtime files or database tables. The phase-1 CLI takes short-lived private SQLite ownership for task-state and configuration reads from [ADR 0011](decisions/0011-phase-one-database-instance-ownership.md); replacing those reads with an authoritative client API remains open.
- Model-provider output is untrusted data. No tool executes outside the runtime policy and approval path. Skills are instruction content and do not grant capabilities.
- The internal `ToolCapabilityKernel` remains fixture-only. The public ledger accepts durable requests, approvals, and audit events but never executes a tool. ADR 0019's observation is a transient normalization boundary only: it carries no task, composition, approval, or executor identity, is not persisted, and does not create a ledger request. Durable execution results, crash-safe side effects, and real executor isolation require separate accepted ADRs.
- Public tool request, approval, and audit identity includes composition node identity, the `cmp_` document identity, the pinned configuration revision, and attempt. An approval decision is ledger state, not execution permission. The current internal tool approval record has only task, attempt, tool name, and argument digest scope and remains unchanged.
- Provider SDKs are replaceable inputs and never own security decisions or durable task state. The phase-1 provider uses direct HTTP, not a provider SDK.
- A task binds to one configuration revision for its lifetime; future configuration changes affect later tasks.
- Existing tasks bind to one runtime configuration revision for life; future changes affect later tasks. The current document is not an Agent definition: its references are opaque, and legacy v2 execution makes no model call.
- Agent profiles never repurpose the one global `configuration_state` pointer. Agent instructions are untrusted user customization content and never grant tools. Any future tool execution must bind authorization and audit identity to the selected Agent revision.
- `schemaVersion: 1` and `schemaVersion: 2` configuration documents are accepted. New sections require a new ADR and a new schema version, never silent reinterpretation of an existing version.
- The public composition section is topology-neutral user-authored data. The runtime must not hardcode an agent topology, layer count, role name, or coordination pattern. Link labels are opaque data. The deterministic topological order is a bounded execution fixture rule, not a concurrency, delegation, or authority contract.
- Bind to loopback only until a reviewed authentication and pairing design exists. The local loopback API is a development boundary, not an authenticated remote deployment design.
- Do not load arbitrary plugins in-process before isolation and grants are designed.

## Current API contract

Conchbase owns [`docs/openapi.yaml`](openapi.yaml). Current API base URL: `http://127.0.0.1:4318`. Pagurus's development server proxies `/v1` to this address. The health endpoint reports API version `1`; the OpenAPI document version is `0.8.0` for the accepted 25-route contract, including Agent resources, provider-neutral model catalog, task binding, versioned configuration revisions, bounded v2 composition execution, the public tool request/approval ledger, and transient provider observations.

Before adding an endpoint, specify request/response schemas, error behavior, authorization requirements, and versioning. Keep public schemas and implementation aligned. Do not add tool execution or remote access as undocumented shortcuts; configuration writes are limited to the accepted `validate`/`apply` contract.

## Technology and commands

- Node.js 24+, TypeScript, Fastify, `node:sqlite`, npm. No provider or storage npm SDK is installed.
- Install and run: `npm ci`, then `npm run dev` (`conchbase serve`).
- CLI: `npm run cli -- models`, `npm run cli -- run "prompt"`, `npm run cli -- tasks`, `npm run cli -- task <id>`, `npm run cli -- events [cursor]`, `npm run cli -- retry <id>`.
- CLI configuration reads: `npm run cli -- config`, `npm run cli -- config-revisions`. These commands take short-lived private database ownership. Configuration writes use the versioned Runtime API.
- Database commands other than `models` take short-lived ownership of the runtime database; do not run them while `conchbase serve` is active. Use the Runtime API for concurrent task inspection.
- Validate changes: `npm run check`, `npm test`, and `npm run build`.
- Runtime host and port: `CONCHBASE_HOST` (loopback only) and `CONCHBASE_PORT`, defaults `127.0.0.1:4318`.
- Current Magpie adapter gateway: `CONCHBASE_MAGPIE_URL`, default `http://127.0.0.1:3425`; optional `CONCHBASE_MAGPIE_APP_KEY` must match `magpie-<app-id>` and names calls in Magpie. These are compatibility-adapter settings, not Agent schema fields.
- Current legacy model id: `CONCHBASE_MODEL`; use `conchbase models` to select an id from the Magpie catalog. Future Agent model references must use the provider-neutral contract, and no Magpie catalog id may be treated as a globally meaningful model identity.
- Runtime database: `CONCHBASE_DB`, default `.conchbase/runtime.sqlite` (git-ignored). Do not put credentials, personal prompts, or user runtime data in the repository.
- Repository: <https://github.com/2648782102/conchbase>. Companion UI: <https://github.com/2648782102/pagurus>.

## Decisions still open

Do not silently treat these as settled:

- Additional provider adapters, adapter-specific settings ownership, normalized provider failures, and provider capability discovery beyond the current Magpie compatibility implementation.
- Authentication/pairing before remote binding; portable profile files and profile export/import; permanent Agent deletion or unarchive; generated client types; UI compare view; and migration support beyond additive schema version 1.
- Agent-aware tool authorization and audit identity before any future Agent can execute a tool. Instructions never grant capability.
- Whether a runtime-wide v2 composition can later be explicitly selected by an Agent, and its model-call/context/permission semantics. Current Agent tasks deliberately use one model turn; composition behavior stays on legacy tasks until a separate decision.
- Failure and race behavior: unknown/archived Agent, empty or oversized instructions, unavailable provider/model, selected-provider outage, concurrent Agent edit and task creation, rollback while a task is active, runtime configuration change during task creation, process restart, and retry. Atomically snapshot both applicable revision ids and effective provider/model when creating a task; never silently switch providers on failure.
- Model-driven composition nodes, delegation, concurrency, per-node model selection, context passing, role semantics, cyclic coordination, and a general scheduling product.
- Portable profile/config file format, migrations, secret resolution, Skill/plugin/MCP bundle schemas, installation/enabling/granting, and approval UX.
- Streaming tool-call accumulation, public tool execution API, durable tool execution results, crash-safe side effects, real executor isolation, per-tool grants, MCP lifecycle, and Pagurus approval UX.
- Provider capability discovery, structured tool calls, multi-turn context, token limits, error classification, adapter compatibility policy, and additional provider ordering.
- Production SQLite driver choice, supported-platform CI matrix, WAL crash recovery, multi-process ownership, event retention, and SSE/Last-Event-ID semantics.
- The authoritative client API that will eventually replace direct CLI database reads, including its authentication and parity contract.
- Remote authentication/pairing and desktop packaging.

When an implementation depends on one of these, record options, consequences, and an explicit recommendation in an ADR before changing the public contract. Keep each change small enough to verify with deterministic local fixtures.

## Recommended next implementation sequence

1. Build the next Pagurus client slice on the closed ADR 0021 acceptance baseline: multi-task history, richer revision comparison, and user-configurable selection preferences, with an explicitly preserved legacy mode.
2. Add another provider adapter only after its credential/settings boundary and deterministic adapter fixtures are available; keep Magpie compatibility covered.
3. Decide separately whether an Agent may explicitly select the global topology and what model-driven node context, delegation, concurrency, and permission semantics apply. Do not infer these from the deterministic executor.
4. Leave tool execution, Skills, MCP, and plugins for separately accepted contracts. Real-provider, visual, accessibility, manual UI, and remote-runtime validation remain separate validation layers.
