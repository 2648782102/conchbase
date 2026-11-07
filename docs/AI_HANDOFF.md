# AI development handoff: Conchbase

> **AI-first project:** Conchbase is developed primarily by AI coding agents. Optimize the repository for fast, accurate agent context loading, bounded changes, and deterministic validation; human handoff is not a product requirement. Keep implementation explicit, typed, and easy to inspect. Start with `AGENTS.md`, then follow this handoff.

This document is the starting packet for a coding model that has not seen the design conversation. It describes repository facts and accepted boundaries; roadmap items are not implemented features.

## Product definition

Conchbase (海螺) is a local-first, headless-capable personal agent runtime. It owns the agent execution loop and can run from a CLI without Pagurus or another graphical interface. Pagurus is an optional control client. Other clients should be able to connect through a stable, documented API.

Target users are open-ended. CLI is one entry point; graphical clients and third-party integrations must remain first-class. Do not design the runtime around one specific UI.

## Read in this order

1. `AGENTS.md` — mandatory coding constraints and AI-first development rule.
2. `docs/AI_DEVELOPMENT.md` — how to make and validate focused changes in this repository.
3. `docs/ARCHITECTURE.md` — runtime and client boundaries plus current source layout.
4. `docs/API.md` and `docs/openapi.yaml` — actual API surface.
5. `docs/TECH_STACK.md` — chosen and deferred technology.
6. `docs/ROADMAP.md` and `docs/decisions/` — intended sequencing and recorded decisions.

## Current repository facts

Implemented:

- Node.js 24+ and TypeScript application shell.
- Fastify server listening on loopback by default.
- `GET /v1/health` and `GET /v1/runtime`, matching `docs/openapi.yaml`.
- Explicit rejection of non-loopback host values.
- npm scripts: `npm run dev`, `npm run check`, `npm test`, and `npm run build`.
- Automated tests cover loopback/port validation and current read-only HTTP response bodies.
- GitHub Actions runs type checks, tests, and a production build on pushes and pull requests.

Not implemented yet:

- Agent/model loop, sessions, task creation, tool registry, MCP client, Skills loader, policy engine, approvals, persistence, memory, artifacts, SSE events, authentication/pairing, or writable API routes.

Do not claim that Conchbase can already run an agent task. The present service is a health/status scaffold.

## Accepted architectural boundaries

- Runtime owns task execution, tool dispatch, policy enforcement, approvals, persisted task state, and the authoritative event log.
- Every client uses the public Runtime API. A client never reads or writes private runtime files or database tables.
- Conchbase owns a task state machine. Provider SDKs may sit behind a replaceable adapter; they must not own security decisions or durable task state.
- MCP is a tool-service protocol. ACP may be an optional client compatibility adapter. Neither replaces the Runtime API.
- Skills are instruction content and do not grant capabilities.
- A task binds to one configuration revision for its lifetime; future configuration changes affect later tasks.
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
- Persistence schema and Node SQLite driver.
- Provider SDK and provider/model support order.
- Profile/config file format, migration policy, and exact secret-store interface.
- Memory data model, retention, import/export, and retrieval strategy.
- MCP process lifecycle, sandboxing, per-tool grants, and approval UX.
- Plugin API and isolation model.
- Remote runtime authentication/pairing and desktop packaging.

When an implementation depends on one of these, write a short ADR with options, consequences, and an explicit recommendation, then obtain product direction before locking the public contract.

## Recommended first implementation sequence

1. Draft ADRs for task lifecycle, cancellation, event ordering/replay, and configuration revision pinning. Record options and a recommendation; get product direction before locking public behavior.
2. Implement the accepted task state machine and event envelope as deterministic, provider-independent modules with transition tests.
3. Add their versioned schemas to OpenAPI before exposing task or event routes.
4. Add fake provider/MCP harnesses and policy/approval gates; prove denied or unapproved actions never execute.
5. Select persistence and provider drivers through focused compatibility checks, then add restart/resume behavior.

Keep each change small enough to verify with deterministic local fixtures. Never use real user credentials in fixture data.
