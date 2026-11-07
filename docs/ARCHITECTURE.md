# Conchbase architecture

## Runtime boundary

Conchbase is the execution authority. It owns task and session state, model calls, tool dispatch, policy checks, approval requests, and durable runtime events. A CLI is one client; no graphical UI is required to start or finish a task.

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

## Extension model

- MCP servers expose tools over a standard protocol and remain independently permission-gated.
- Skills are instruction content and do not grant tool permissions.
- Arbitrary in-process plugins are out of the initial runtime scope. A later plugin host must define isolation, lifecycle, and capability grants first.

## Initial implementation boundary

The repository currently contains the HTTP service shell and read-only health/runtime endpoints. No model call, external tool execution, or writable management endpoint is exposed yet.
