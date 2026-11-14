# Decision 0054: MCP capability provider

Status: **accepted implementation contract; first read-only slice implemented**

Date: 2026-11-14 (Asia/Shanghai).

## Context

ADR 0052 accepts a capability-provider seam for built-in tools, MCP, Skills, and plugins. ADR 0053 implements the loop with built-in read-only tools. The next capability source is MCP: users already run MCP servers, and their tools should become available to Agents without giving a model the ability to launch processes.

The repository forbids `@modelcontextprotocol/sdk` as a dependency. The provider therefore implements the JSON-RPC 2.0 stdio transport directly, with no new runtime dependency.

## Decision

1. MCP servers are **administrator-configured**, never model-configured. A server is declared in a local JSON config referenced by `CONCHBASE_MCP_CONFIG`. The Runtime reads it at startup. A model, Agent revision, Skill, plugin, or client cannot add, spawn, or reconfigure a server.
2. Each server declaration contains `id`, absolute `command`, `args`, optional `env` allowlist, and an explicit `tools` allowlist. Each allowlisted tool declares `name` and `sideEffect` (`read` | `write` | `external`). Tools not listed are invisible and cannot be called.
3. This first slice exposes only `read` tools. `write` and `external` tools are refused at the provider boundary until their approval and idempotency contracts are accepted.
4. The Runtime launches each server as a child process with a sanitized environment (no inherited provider credentials), a bounded startup and per-call timeout, a bounded stdout buffer, and no shell. It performs the MCP `initialize` handshake, `tools/list` discovery, and `tools/call`.
5. Public tool ids are namespaced and sanitized to the existing tool-name grammar: `mcp_<server>_<tool>`. The mapping to the original MCP tool name stays inside the provider.
6. Tool results are bounded: text content is truncated to a configured byte cap, non-text content is summarized by type only, and only a digest plus bounded summary enters model context and events. Raw server envelopes, stderr, and environment values never appear in events, logs, or client responses.
7. A server that fails to start, times out, exits, or returns malformed JSON-RPC is reported as a bounded tool failure code; the loop continues and the model observes the error, exactly like built-in tool failures.
8. Restart does not replay MCP calls. In-flight calls are lost with the task, which becomes `interrupted` under existing semantics.
9. No public path, schema field, approval route, or client surface is added. MCP tools flow through the existing Agent loop and event vocabulary.

## Options

### A. Add the official MCP SDK

Consequences: new runtime dependency and a lifecycle/transport surface the repository currently forbids. Rejected for now.

### B. Let the model connect to MCP servers

Consequences: prompt injection becomes process execution. Rejected.

### C. Administrator-configured stdio servers with an explicit read-only tool allowlist

Consequences: real MCP interoperability with bounded risk and no new dependency. Accepted.

## Validation

- `tests/mcp-provider.test.ts` uses a local fixture MCP server over stdio and covers discovery, namespacing, successful calls, tool-not-allowlisted rejection, side-effect rejection, timeout, malformed JSON-RPC, and bounded output.
- `tests/agent-loop.test.ts` covers loop integration through a provider.
- Both repositories pass `npm run check`, `npm test`, and `npm run build`.

## Consequences

Users can attach existing MCP servers and let Agents read through them. Write-capable MCP tools, remote transports, server lifecycle UI, and credential injection remain blocked pending their own accepted ADRs.
