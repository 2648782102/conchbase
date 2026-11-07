# AI development handoff: Conchbase

> **AI-first project:** Conchbase is developed primarily by AI coding agents. Optimize the repository for fast, accurate agent context loading, bounded changes, and deterministic validation; human handoff is not a product requirement. Keep implementation explicit, typed, and easy to inspect. Start with `AGENTS.md`, then follow this handoff.

This document is the starting packet for a coding model that has not seen the design conversation. It describes repository facts and accepted boundaries; roadmap items are not implemented features.

## Product definition

Conchbase (海螺) is a local-first, headless-capable personal agent runtime. It owns the agent execution loop and can run from a CLI without Pagurus or another graphical interface. Pagurus is an optional control client. Other clients should be able to connect through a stable, documented API.

Target users are open-ended. CLI is one entry point; graphical clients and third-party integrations must remain first-class. Do not design the runtime around one specific UI.

Users should be able to define a highly customizable agent composition. Composition must remain topology-neutral: a layered arrangement with several specialized roles is an illustrative example, not a built-in structure, default template, required hierarchy, or accepted schema. See [ADR 0005](decisions/0005-user-defined-agent-topology-proposal.md). This is product intent only; no agent composition is implemented in the current scaffold.

## Read in this order

1. `AGENTS.md` — mandatory coding constraints and AI-first development rule.
2. `docs/AI_DEVELOPMENT.md` — how to make and validate focused changes in this repository.
3. `docs/ARCHITECTURE.md` — runtime and client boundaries plus current source layout.
4. `docs/API.md` and `docs/openapi.yaml` — actual API surface.
5. `docs/TECH_STACK.md` — chosen and deferred technology.
6. `docs/ROADMAP.md`, `docs/REFERENCE_PROJECTS.md`, and `docs/decisions/` — intended sequencing, dated external research, and recorded decisions.
7. `docs/AI_TASK_QUEUE.md` — bounded work that is ready for the next coding model.

## Current repository facts

Implemented:

- Node.js 24+ and TypeScript application shell.
- Fastify server listening on loopback by default.
- `GET /v1/health` and `GET /v1/runtime`, matching `docs/openapi.yaml`.
- Explicit rejection of non-loopback host values.
- npm scripts: `npm run dev`, `npm run check`, `npm test`, and `npm run build`.
- Automated tests cover loopback/port validation, current read-only HTTP response bodies and OpenAPI shapes, legal task transitions, cancellation, event ordering/replay, configuration revision pinning, a tool policy gate, and provider-independent fake-model terminal-state paths.
- Deterministic internal modules under `src/runtime/` are not exposed through HTTP. Their fake model and tool callbacks are test fixtures; they do not execute real tools or call a model provider.
- Proposal ADRs `0002`–`0004` record options and recommendations for the still-open public task/event/configuration contracts. `0005` records topology-neutral product direction; `0006`–`0007` propose provider and configuration boundaries. `docs/REFERENCE_PROJECTS.md` records a dated GitHub Trending snapshot and its explicitly rejected patterns.
- GitHub Actions runs type checks, tests, and a production build on pushes and pull requests.

Not implemented yet:

- Agent/model loop, sessions, task creation, user-defined agent composition, role registry, tool registry, MCP client, Skills loader, policy engine, approvals, persistence, memory, artifacts, SSE events, authentication/pairing, or writable API routes.

Do not claim that Conchbase can already run an agent task. The present service is a health/status scaffold.

## Accepted architectural boundaries

- Runtime owns task execution, tool dispatch, policy enforcement, approvals, persisted task state, and the authoritative event log.
- Every client uses the public Runtime API. A client never reads or writes private runtime files or database tables.
- Conchbase owns a task state machine. Provider SDKs may sit behind a replaceable adapter; they must not own security decisions or durable task state.
- MCP is a tool-service protocol. ACP may be an optional client compatibility adapter. Neither replaces the Runtime API.
- Skills are instruction content and do not grant capabilities.
- A task binds to one configuration revision for its lifetime; future configuration changes affect later tasks.
- The runtime must not hardcode an agent topology, layer count, role name, or coordination pattern. Composition data is user-authored and versioned; it is not yet implemented.
- Bind to loopback only until a reviewed authentication and pairing design exists.
- Do not load arbitrary plugins in-process before isolation and grants are designed.

## Current API contract

Conchbase is the source of truth for [`docs/openapi.yaml`](openapi.yaml). Current API base URL: `http://127.0.0.1:4318`; current endpoints are read-only health and runtime status. Pagurus's development server proxies `/v1` to this address.

Before adding an endpoint, specify request/response schemas, error behavior, authorization requirements, and versioning. Do not add task/config write routes as an undocumented shortcut.

## Technology and commands

- Node.js 24+, TypeScript, Fastify, npm.
- Start locally: `npm ci`, then `npm run dev`.
- Validate changes: `npm run check`, `npm test`, and `npm run build`.
- Type check: `npm run check`.
- Production compile: `npm run build` (clears `dist/` before compiling).
- Runtime port: `CONCHBASE_PORT`, default `4318`.
- Runtime host: `CONCHBASE_HOST`, restricted to `localhost`, `127.0.0.1`, or `::1`.
- Repository: <https://github.com/2648782102/conchbase>.
- Companion UI: <https://github.com/2648782102/pagurus>.

## Decisions still open

Do not silently treat these as settled:

- Task/session API, event envelope, replay/cursor semantics, and SSE details.
- User-authored composition schema, identity, validation, delegation, concurrency, and cancellation propagation; ADR `0005` is a proposal, not a contract.
- Persistence schema and Node SQLite driver.
- Provider SDK and provider/model support order.
- Profile/config file format, migration policy, and exact secret-store interface.
- Memory data model, retention, import/export, and retrieval strategy.
- MCP process lifecycle, sandboxing, per-tool grants, and approval UX.
- Plugin API and isolation model.
- Remote runtime authentication/pairing and desktop packaging.

When an implementation depends on one of these, write a short ADR with options, consequences, and an explicit recommendation, then obtain product direction before locking the public contract.

## Recommended first implementation sequence

1. Read `docs/AI_TASK_QUEUE.md`, `docs/REFERENCE_PROJECTS.md`, and proposal ADRs `0002`–`0007`; do not treat them as accepted public contracts.
2. Obtain product direction on task IDs, event envelopes/cursors, and configuration schema before changing `docs/openapi.yaml`.
3. ~~Add provider-independent acceptance tests and policy fixtures around the existing deterministic core.~~ Done for the current internal core; see `docs/AI_TASK_QUEUE.md`.
4. Run the storage compatibility spike in a scratch branch, then select persistence and provider drivers through focused checks before adding restart/resume behavior.
5. Only after an ADR is accepted, add versioned schemas to OpenAPI and expose task or event routes.

Keep each change small enough to verify with deterministic local fixtures. Never use real user credentials in fixture data.
