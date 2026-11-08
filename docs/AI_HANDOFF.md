# AI development handoff: Conchbase

> **AI-first project:** Conchbase is developed primarily by AI coding agents. Optimize the repository for fast, accurate agent context loading, bounded changes, and deterministic validation; human handoff is not a product requirement. Keep implementation explicit, typed, and easy to inspect. Start with `AGENTS.md`, then follow this handoff.

This document is the starting packet for a coding model that has not seen the design conversation. It describes repository facts and accepted boundaries; roadmap items are not implemented features.

## Product definition

Conchbase (海螺) is a local-first, headless-capable personal agent runtime. It owns the agent execution loop and can run from a CLI without Pagurus or another graphical interface. Pagurus is an optional control client. Other clients should be able to connect through a stable, documented API. Target users are open-ended; CLI, GUI, and third-party integrations are all valid clients.

Users should eventually define highly customizable agent compositions. Composition must remain topology-neutral: a layered arrangement with several specialized roles is an illustrative example, not a built-in structure, default template, required hierarchy, or accepted schema. See [ADR 0005](decisions/0005-user-defined-agent-topology-proposal.md). Phase 1 does not implement user-defined agent composition; its single-turn execution unit is an implementation boundary for proving the real-model loop, not a canonical product topology.

## Read in this order

1. `AGENTS.md` — mandatory coding constraints and AI-first development rule.
2. This handoff, then `docs/AI_DEVELOPMENT.md`.
3. [ADR 0010](decisions/0010-first-real-model-slice.md) — accepted phase-1 direction, trade-offs, and explicit non-goals.
4. [ADR 0011](decisions/0011-phase-one-database-instance-ownership.md) — accepted phase-1 single-instance persistence boundary.
5. [ADR 0012](decisions/0012-streaming-output-progress.md) — accepted streaming progress contract and non-goals.
6. [ADR 0013](decisions/0013-bounded-tool-capability-kernel.md) — accepted internal tool capability kernel; no public tool execution.
7. [ADR 0014](decisions/0014-versioned-configuration-api.md) — accepted `0.4.0` configuration document, revision history, validation, apply, and rollback.
8. [ADR 0015](decisions/0015-composition-identity-kernel.md) — accepted internal topology-neutral composition identity and sequencing before public tool contracts.
9. `docs/ARCHITECTURE.md` — runtime and client boundaries plus current source layout.
10. `docs/API.md` and `docs/openapi.yaml` — the versioned API source of truth.
11. `docs/TECH_STACK.md` — chosen and deferred technology.
12. `docs/ROADMAP.md`, `docs/REFERENCE_PROJECTS.md`, and proposal ADRs `0002`–`0008` — wider intended sequencing and still-open contracts.
13. `docs/AI_TASK_QUEUE.md` — bounded work for the next coding model.

## Current repository facts

Implemented:

- Node.js 24+ and TypeScript application, Fastify loopback API, and a `conchbase` CLI.
- Phase 1 connects a real model through Magpie's local OpenAI Chat Completions-compatible gateway. The HTTP task path uses one streaming request with a narrow adapter, injectable `fetch`, an `AbortSignal`, and normalized errors; it ignores reasoning text, rejects model-requested tools, and does not execute them.
- `POST /v1/tasks` creates and starts one bounded text task; `GET /v1/tasks` and `GET /v1/tasks/{taskId}` read persisted task state. `POST .../cancel` and `POST .../retry` expose cancellation and explicit retry.
- `GET /v1/models` reads Magpie's model catalog. `GET /v1/events?after=<eventId>` reads durable, globally ordered events. See `docs/openapi.yaml` and `docs/API.md`.
- Answer-text chunks become durable `task.output_delta` events with per-attempt `index` and `outputLength`; `GET /v1/tasks/{taskId}` exposes the current `partialOutput` while a task is active. Final `output` remains authoritative and `partialOutput` is cleared on terminal states. Polling is the client transport; there is no SSE route yet.
- Tasks, attempts, outputs, errors, and events are persisted by `SqliteTaskStore` using Node 24's built-in `node:sqlite` `DatabaseSync`. Task state and its event commit in one transaction. WAL and foreign keys are enabled.
- `SqliteTaskStore` holds a SQLite exclusive lock for the database and normalizes a second owner to `DatabaseInstanceError`. This is a single-owner development boundary, not multi-process support or a production recovery matrix. `conchbase models` uses a standalone `MagpieModelCatalog` and does not open the runtime database.
- A process restart marks nonterminal tasks as `interrupted`. It does not resume an in-flight model call. An explicit retry creates a new attempt from the original prompt and preserves previous events.
- A versioned `schemaVersion: 1` configuration document is persisted as content-addressed immutable revisions in the same private SQLite database. `/v1/configuration` reads the active revision; `/v1/configuration/revisions` lists history; `/v1/configuration/validate`, `/v1/configuration/apply`, and rollback by `rollbackTo` are implemented. All document sections, including `metadata`, are required; `source: url` is not accepted in this schema version. References are opaque data and do not install, enable, grant, resolve secrets, load code, or execute tools.
- Every task attempt pins the active configuration revision at creation. Applying or rolling back a revision affects later tasks only; existing task rows and events retain their original pinned id.
- Automated tests cover provider parsing and failures, task completion, durable event replay, restart interruption, explicit retry, configuration validation/history/rollback/pinning, HTTP error behavior, loopback configuration, the internal task runner, policy gate, and deterministic repository guardrails. Tests use fake `fetch` and temporary databases; CI does not call a model provider.
- Streaming tests cover SSE frame parsing, ignored reasoning, tool-call rejection, malformed/truncated streams, cancellation, durable progress, and Pagurus's visible progress display.
- An internal `ToolCapabilityKernel` provides an immutable fixture-only registry, exact versioned approval records, per-attempt idempotency keys, bounded audit scalars, and replayable normalized executor failures. Its tool-prefixed event names are internal deterministic-test vocabulary. It is not imported by the HTTP task path, is not persisted by `SqliteTaskStore`, and does not execute real host tools.
- An internal `src/runtime/composition-document.ts` validates topology-neutral directed acyclic graphs and computes content-addressed `cmp_` identities from canonical user-authored nodes, links, entry nodes, and metadata. It has no public route, configuration schema section, persistence, model or tool execution, capability grant, or scheduling semantics. Link labels are opaque data. See [ADR 0015](decisions/0015-composition-identity-kernel.md).
- GitHub Actions runs `npm run check`, `npm test`, and `npm run build`.

Not implemented yet:

- User-defined agent composition, role registry, multi-turn model context, model-driven tool execution, public tool/approval API, MCP client, Skills loader, install/enable/grant operations, secret resolution, portable file import/export, production approval workflow, plugin host, memory, artifacts, SSE event stream, reasoning display, event retention policy, production driver compatibility matrix, authentication/pairing, or remote binding.
- A Magpie upstream Agents-page adapter. Magpie currently requires such an adapter in its own source; Conchbase phase 1 uses the local gateway directly.

Do not describe planned features as implemented. Do not describe the phase-1 single-turn loop as an accepted composition schema.

## Accepted architectural boundaries

- Conchbase is the agent execution authority. It owns task state, provider calls, the narrow model adapter boundary, persisted state, and the authoritative event log.
- Pagurus and other external clients use the public Runtime API and never read or write private runtime files or database tables. The phase-1 CLI takes short-lived private SQLite ownership for task-state and configuration reads from [ADR 0011](decisions/0011-phase-one-database-instance-ownership.md); replacing those reads with an authoritative client API remains open.
- Model-provider output is untrusted data. No tool executes outside the runtime policy and approval path. Skills are instruction content and do not grant capabilities.
- Tool capability records and tool-prefixed audit events are internal deterministic fixtures until a separate ADR accepts a public tool/event contract, provider tool-call parsing, durable approval and audit storage, and real executor isolation. Public routes continue to expose only the phase-1 task events described in `docs/openapi.yaml`.
- Public tool approvals and audits must include composition node identity and the pinned configuration revision before model-driven or real host tools execute in a multi-node composition. The current internal tool approval record has only task, attempt, tool name, and argument digest scope.
- Provider SDKs are replaceable inputs and never own security decisions or durable task state. The phase-1 provider uses direct HTTP, not a provider SDK.
- A task binds to one configuration revision for its lifetime; future configuration changes affect later tasks.
- Public configuration documents are versioned data; only `schemaVersion: 1` is accepted. New sections require a new ADR and a new schema version, never silent reinterpretation.
- The runtime must not hardcode an agent topology, layer count, role name, or coordination pattern.
- The internal composition validator accepts arbitrary single-node and multi-node directed acyclic graphs; its current acyclicity and entry-set checks are structural fixture rules. They do not define execution order, concurrency, delegation, scheduling, or a public composition schema.
- Bind to loopback only until a reviewed authentication and pairing design exists. The local loopback API is a development boundary, not an authenticated remote deployment design.
- Do not load arbitrary plugins in-process before isolation and grants are designed.

## Current API contract

Conchbase owns [`docs/openapi.yaml`](openapi.yaml). Current API base URL: `http://127.0.0.1:4318`. Pagurus's development server proxies `/v1` to this address. The health endpoint reports API version `1`; the OpenAPI document version is `0.4.0` for the phase-1 route set plus versioned configuration revisions.

Before adding an endpoint, specify request/response schemas, error behavior, authorization requirements, and versioning. Keep public schemas and implementation aligned. Do not add tool execution or remote access as undocumented shortcuts; configuration writes are limited to the accepted `validate`/`apply` contract.

## Technology and commands

- Node.js 24+, TypeScript, Fastify, `node:sqlite`, npm. No provider or storage npm SDK is installed.
- Install and run: `npm ci`, then `npm run dev` (`conchbase serve`).
- CLI: `npm run cli -- models`, `npm run cli -- run "prompt"`, `npm run cli -- tasks`, `npm run cli -- task <id>`, `npm run cli -- events [cursor]`, `npm run cli -- retry <id>`.
- CLI configuration reads: `npm run cli -- config`, `npm run cli -- config-revisions`. These commands take short-lived private database ownership. Configuration writes use the versioned Runtime API.
- Database commands other than `models` take short-lived ownership of the runtime database; do not run them while `conchbase serve` is active. Use the Runtime API for concurrent task inspection.
- Validate changes: `npm run check`, `npm test`, and `npm run build`.
- Runtime host and port: `CONCHBASE_HOST` (loopback only) and `CONCHBASE_PORT`, defaults `127.0.0.1:4318`.
- Model gateway: `CONCHBASE_MAGPIE_URL`, default `http://127.0.0.1:3425`; optional `CONCHBASE_MAGPIE_APP_KEY` must match `magpie-<app-id>` and names calls in Magpie.
- Model id: `CONCHBASE_MODEL`; use `conchbase models` to select an id from the user's Magpie catalog. No model id is hardcoded in the product.
- Runtime database: `CONCHBASE_DB`, default `.conchbase/runtime.sqlite` (git-ignored). Do not put credentials, personal prompts, or user runtime data in the repository.
- Repository: <https://github.com/2648782102/conchbase>. Companion UI: <https://github.com/2648782102/pagurus>.

## Decisions still open

Do not silently treat these as settled:

- User-authored public composition schema, configuration schema version, task and event identity, delegation, concurrency, cancellation propagation, and execution semantics. ADR 0015 accepts only an internal topology-neutral identity kernel.
- Portable profile/config file format, migrations, secret resolution, Skill/plugin/MCP bundle schemas, installation/enabling/granting, and approval UX.
- Provider capability discovery, structured tool calls, multi-turn context, token limits, error classification, and direct vendor provider order.
- Production SQLite driver choice, supported-platform CI matrix, WAL crash recovery, multi-process ownership, event retention, and SSE/Last-Event-ID semantics.
- The authoritative client API that will eventually replace direct CLI database reads, including its authentication and parity contract.
- MCP lifecycle and sandboxing, per-tool grants, public tool/approval API, provider tool-call parsing, durable tool audit storage, crash-safe side effects, plugin isolation, memory model, remote authentication/pairing, and desktop packaging.

When an implementation depends on one of these, record options, consequences, and an explicit recommendation in an ADR before changing the public contract. Keep each change small enough to verify with deterministic local fixtures.
