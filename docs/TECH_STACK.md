# Technology baseline

| Area | Baseline | State |
|---|---|---|
| Runtime and CLI | TypeScript on Node.js 24+ | In use |
| HTTP server | Fastify | In use |
| API contract | Versioned HTTP/JSON, JSON Schema, OpenAPI | In use for status, task, event, model, configuration, and composition routes |
| Model provider | Direct OpenAI Chat Completions-compatible streaming HTTP to local Magpie | In use for phase 1; no provider SDK |
| Task and event state | `node:sqlite` `DatabaseSync` behind `TaskStore`, with one exclusive owner per database | In use for local phase 1; production platform matrix and migrations pending |
| Model discovery | Direct HTTP to Magpie's `/v1/models` behind `MagpieModelCatalog` | In use; database-free and independent of `TaskService` |
| Runtime events | Global monotonic event IDs, durable `task.output_delta` progress, and polling cursor | In use; SSE and retention pending |
| Configuration revisions | Versioned `schemaVersion: 1` and `schemaVersion: 2` documents, SHA-256 identity, SQLite history, active pointer, validation, apply, and rollback | In use as data only; portable files, secret resolution, installers, and grants deferred |
| Composition identity and execution | Public topology-neutral graph section, internal canonical DAG validation, SHA-256 `cmp_` identity, deterministic topological node order, and node events | In use for bounded deterministic execution; model-driven node work, scheduling, and tool audits deferred |
| Tool capability kernel | Internal fixture-only registry, exact approvals, per-attempt idempotency, and deterministic audit events | In use as an internal acceptance boundary; public tool routes and real host tools deferred |
| Tool protocol | MCP TypeScript SDK | Deferred until lifecycle, sandboxing, and per-tool grants are accepted |
| Agent orchestration | Conchbase-owned task state machine with a narrow provider adapter and a deterministic composition executor | In use for one bounded text turn or bounded graph traversal; tool loops and model-driven composition pending |
| Configuration and Skills | Content-addressed revision id, v1/v2 documents, and future portable profile files | Revision id and configuration write API in use; profile files and Skills lifecycle deferred |

The runtime is primarily I/O orchestration. Model inference belongs to a local gateway or external provider, so a separate inference language is not part of the baseline. The public API stays language-neutral for non-TypeScript clients.

`node:sqlite` is experimental in Node 24. It avoids a native npm dependency for this local slice, but production choice, supported OS/CPU/Node combinations, WAL crash recovery, migrations, and multi-process ownership remain open. [ADR 0008](decisions/0008-sqlite-driver-compatibility-proposal.md) records dated single-machine evidence; [ADR 0010](decisions/0010-first-real-model-slice.md) accepts only the phase-1 internal schema; [ADR 0011](decisions/0011-phase-one-database-instance-ownership.md) accepts a fail-fast single-owner boundary; [ADR 0012](decisions/0012-streaming-output-progress.md) accepts bounded progress events.

[ADR 0013](decisions/0013-bounded-tool-capability-kernel.md) accepts an internal tool capability kernel without adding an MCP SDK, provider SDK, real executor, approval route, or durable audit table. Its audit log is in-memory and its idempotency coordinator is process-local. [ADR 0014](decisions/0014-versioned-configuration-api.md) accepts public configuration documents and durable revisions without adding a file loader, secret store, capability installer, or composition schema. [ADR 0015](decisions/0015-composition-identity-kernel.md) accepts an internal topology-neutral identity kernel. [ADR 0016](decisions/0016-composition-execution-and-public-schema.md) accepts the public composition section and deterministic execution, and requires composition node identity in future public tool approvals and audits.

Repository guardrails use Node's built-in test runner and local-file assertions; they are development checks, not runtime technology.

## Deferred choices

- Provider capability discovery, structured tool calls, multi-turn context, error classification, direct vendor adapters, public tool/approval routes, durable approvals, crash-safe side effects, model-driven composition scheduling, portable configuration files, secret resolution, and install/enable/grant operations.
- Production SQLite driver, schema migrations, retention, SSE, and `Last-Event-ID` mapping.
- Plugin isolation and capability grants.
- Remote authentication, pairing, and desktop packaging.
