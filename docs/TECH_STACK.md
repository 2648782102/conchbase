# Technology baseline

| Area | Baseline | State |
|---|---|---|
| Runtime and CLI | TypeScript on Node.js 24+ | In use |
| HTTP server | Fastify | In use |
| API contract | Versioned HTTP/JSON, JSON Schema, OpenAPI | In use for phase-1 status, task, event, and model routes |
| Model provider | Direct OpenAI Chat Completions-compatible HTTP to local Magpie | In use for phase 1; no provider SDK |
| Task and event state | `node:sqlite` `DatabaseSync` behind `TaskStore` | In use for local phase 1; production platform matrix and migrations pending |
| Runtime events | Global monotonic event IDs and polling cursor | In use; SSE and retention pending |
| Tool protocol | MCP TypeScript SDK | Deferred until lifecycle, sandboxing, and per-tool grants are accepted |
| Agent orchestration | Conchbase-owned task state machine with a narrow provider adapter | In use for one bounded text turn; composition and tool loops pending |
| Configuration and Skills | Content-addressed revision id and future portable profile files | Revision id in use; profile schema, Skills, and write API deferred |

The runtime is primarily I/O orchestration. Model inference belongs to a local gateway or external provider, so a separate inference language is not part of the baseline. The public API stays language-neutral for non-TypeScript clients.

`node:sqlite` is experimental in Node 24. It avoids a native npm dependency for this local slice, but production choice, supported OS/CPU/Node combinations, WAL crash recovery, migrations, and multi-process ownership remain open. [ADR 0008](decisions/0008-sqlite-driver-compatibility-proposal.md) records dated single-machine evidence; [ADR 0010](decisions/0010-first-real-model-slice.md) accepts only the phase-1 internal schema.

Repository guardrails use Node's built-in test runner and local-file assertions; they are development checks, not runtime technology.

## Deferred choices

- Provider capability discovery, streaming, structured tool calls, multi-turn context, error classification, and direct vendor adapters.
- Production SQLite driver, schema migrations, retention, SSE, and `Last-Event-ID` mapping.
- Plugin isolation and capability grants.
- Remote authentication, pairing, and desktop packaging.
