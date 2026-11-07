# Conchbase architecture

## Runtime boundary

Conchbase is the execution authority. It owns task and session state, model calls, tool dispatch, policy checks, approval requests, and durable runtime events. A CLI is one client; no graphical UI is required to start or finish a task.

User-defined agent composition is intended to be topology-neutral. A layered multi-role setup is only an illustrative example and must not become a built-in structure, default template, required layer count, or role-name convention. See [ADR 0005](decisions/0005-user-defined-agent-topology-proposal.md); no composition behavior is implemented yet.

```text
CLI ────────────┐
Pagurus ────────┼── versioned Runtime API ── Conchbase Runtime
External clients┘                              ├─ task state machine
ACP clients ───────── optional adapter ────────├─ model adapters
                                                ├─ policy and approvals
                                                ├─ MCP client / Skill loader
                                                └─ storage and event log
```

## Interface rules

- HTTP/JSON is the management and task API; SSE carries ordered runtime events.
- JSON Schema is the source for request and response validation. Public schemas receive explicit versions.
- Events have stable IDs and task IDs so clients can resume after reconnecting.
- ACP is an optional compatibility adapter for agent clients. MCP is used for tool services; neither replaces the Runtime API.
- Browser clients connect to a same-origin console or an explicitly paired local endpoint. The runtime binds to loopback by default.

## State and configuration

- User-authored profile, policy, and Skill files are portable configuration inputs.
- Runtime operational state (sessions, tasks, approvals, and events) belongs to a transactional local store.
- Artifacts live as files referenced from runtime records.
- Secrets are referenced by name and resolved by the runtime from an operating-system credential store or explicitly configured environment.
- Each task is pinned to a configuration revision. Applying a new revision affects new tasks.
- A future versioned profile may describe a user-authored composition, but its topology, identity model, delegation, concurrency, and validation rules remain open decisions.

## Extension model

- MCP servers expose tools over a standard protocol and remain independently permission-gated.
- Skills are instruction content and do not grant tool permissions.
- Arbitrary in-process plugins are out of the initial runtime scope. A later plugin host must define isolation, lifecycle, and capability grants first.
- Provider adapters, Skills, MCP servers, and any future declarative plugins are replaceable inputs. None owns the public Runtime API, durable task state, or final authorization; see [ADR 0006](decisions/0006-provider-adapter-capability-boundary-proposal.md) and [ADR 0007](decisions/0007-skill-plugin-mcp-configuration-proposal.md).

## Initial implementation boundary

The repository currently contains the HTTP service shell and read-only health/runtime endpoints. No model call, external tool execution, or writable management endpoint is exposed yet.

`src/runtime/` holds internal deterministic domain modules for task transitions, ordered events, configuration revisions, tool policy decisions, a provider-independent model adapter contract, and an internal task-runner acceptance harness. They are deliberately outside `src/http/`; their shapes are proposal material, not the public API. The scripted model adapter and tool callbacks live in `tests/fixtures/`. See `docs/decisions/0002-task-lifecycle-proposal.md`, `0003-event-ordering-proposal.md`, `0004-configuration-revision-proposal.md`, and `0005-user-defined-agent-topology-proposal.md` through `0007-skill-plugin-mcp-configuration-proposal.md`.

## Source layout

```text
src/
├── config/runtime-config.ts       # environment parsing and startup validation
├── http/
│   ├── create-app.ts               # Fastify construction and route registration
│   └── routes/v1/                  # versioned HTTP route handlers
├── runtime/                        # internal deterministic domain modules, not public API
└── main.ts                         # process entry point and listener lifecycle
```

Keep the current scaffold small. Add a module when there is a real capability to own; do not create empty layers or generic frameworks in advance. As execution capabilities arrive, organize changes as bounded vertical slices with domain rules separate from HTTP and provider/storage adapters. Keep replaceable or security-sensitive boundaries explicit, and avoid interfaces that only rename a single call without protecting a real boundary.
