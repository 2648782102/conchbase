# Technology baseline

This records the initial implementation choices. Revisit a choice through a short decision record when requirements change.

| Area | Baseline | State |
|---|---|---|
| Runtime and CLI | TypeScript on Node.js 24+ | In use |
| HTTP server | Fastify | In use for the read-only service shell |
| API contract | Versioned HTTP/JSON, JSON Schema, OpenAPI documentation | Planned; health endpoints are the only current routes |
| Runtime events | Resumable SSE with stable event IDs | Planned |
| Tool protocol | MCP TypeScript SDK v2 | Planned |
| Agent orchestration | Conchbase-owned task state machine; provider SDK behind an adapter | Planned |
| Operational state | SQLite behind a storage interface | Planned; select the Node driver after a focused compatibility check |
| Configuration and Skills | Portable profile files and Markdown Skills, validated by versioned schemas | Planned |

The runtime is primarily I/O orchestration. A separate language is not justified by model inference, which is performed by model providers or external local-model processes. The public API remains language-neutral for non-TypeScript clients.

## Deferred choices

- Provider SDK: evaluate provider coverage, streaming, structured tool calls, cancellation, and checkpoint behavior before choosing an adapter.
- SQLite driver: Node's built-in `node:sqlite` is not the initial production dependency; keep storage behind a narrow interface.
- Plugin execution: defer arbitrary code loading until isolation and capability grants are specified.
- Remote access and desktop packaging: defer until pairing, authentication, and supported operating systems are defined.
