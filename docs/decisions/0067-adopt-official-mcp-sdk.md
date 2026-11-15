# Decision 0067: Adopt the official MCP SDK for the stdio transport

Status: **accepted and implemented dependency change**

Date: 2026-11-15 (Asia/Shanghai).

## Context

ADR 0054 implemented a read-only MCP provider with a hand-written JSON-RPC 2.0 framing layer: `initialize`, `notifications/initialized`, `tools/list`, `tools/call`, newline-delimited framing, a pending-request map, per-request timers, and buffer-size enforcement. That was roughly 120 lines of code reimplementing a published protocol.

The dependency baseline (`fastify` only, with `@modelcontextprotocol/sdk` explicitly forbidden) was chosen in ADR 0010/0054 when the goal was to prove the boundary with zero third-party code. That goal is met. The cost now is maintenance of protocol plumbing that the protocol's own maintainers ship, test, and version — including protocol revisions our hand-written layer does not track.

This ADR changes **how** the MCP transport is spoken. It does not change which MCP tools an Agent may use, which is ADR 0066's grant boundary and remains the Runtime's decision.

## Decision

1. `src/runtime/mcp-provider.ts` uses `@modelcontextprotocol/sdk`'s `Client` and `StdioClientTransport` instead of a hand-written JSON-RPC layer.
2. Everything above the transport stays Conchbase-owned and unchanged: the bounded config schema, administrator-only declaration, server-id and tool-name validation, namespaced public tool ids, sanitized child environment (`PATH=""`, `NODE_OPTIONS=""`, plus declared vars), per-call timeout, result byte cap, `ToolRejectedError` codes, and the `ToolProvider` seam.
3. The SDK is pinned as a direct runtime dependency with an exact minor range, so a protocol change arrives as a reviewed dependency update rather than an implicit drift.
4. The SDK never decides authorization. It parses and transports messages; `TaskService` still filters by the pinned Agent revision's `grantedCapabilities`, and the approval path is unchanged.
5. The stdio transport keeps `shell: false` semantics (the SDK spawns the command directly) and inherits the sanitized environment. Server stderr is piped and drained, never forwarded to a model.
6. Repository guardrails move `@modelcontextprotocol/sdk` from the forbidden list into the allowed runtime set, and the dependency assertion becomes an explicit allowlist rather than `['fastify']`.

## Options

### A. Keep the hand-written JSON-RPC layer

Consequences: zero dependency growth, but Conchbase keeps owning framing, request correlation, timeout behaviour, and protocol revision tracking that it did not design. The current layer also silently ignores parse failures and non-numeric ids, which is exactly the kind of protocol edge the SDK handles explicitly. Rejected.

### B. Adopt a third-party agent framework that bundles MCP

Consequences: it would take over the agent loop, which conflicts with the product invariant that Conchbase owns execution. Rejected.

### C. Adopt the official SDK for transport only

Consequences: less code to maintain, protocol conformance from the protocol's own maintainers, and no change to the authority boundary. Accepted.

## Validation

- All eight existing `tests/mcp-provider.test.ts` fixtures pass unchanged against the SDK transport: discovery, namespacing, successful calls, unknown-tool rejection, non-read rejection, server errors, hung-call timeout, malformed declarations, oversized-result truncation, config round-trip, and the Agent-loop MCP acceptance.
- `npm run check`, `npm test`, and `npm run build` pass.

## Consequences

One runtime dependency is added, deliberately. The MCP transport is now maintained by the protocol's owners, and Conchbase keeps the parts that encode its own product invariants: bounded configuration, sanitized environment, namespacing, digest-only audit, and Agent-scoped grants. Write-capable and remote MCP transports remain gated by their own decisions, not by this dependency change.
