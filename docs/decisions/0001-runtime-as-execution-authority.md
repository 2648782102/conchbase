# Decision 0001: Runtime owns execution

Status: accepted for the initial scaffold.

Conchbase owns the task loop, tool dispatch, permission checks, and persisted runtime state. CLI, Pagurus, IDEs, and other UIs connect as clients. This allows interfaces to change without moving agent execution or security enforcement into a UI.

Task and event API contracts are versioned. ACP may be implemented as an adapter; MCP remains the tool integration protocol.
