# Runtime API status

The service listens on `127.0.0.1:4318` by default. The machine-readable source of truth for all routes is [`openapi.yaml`](openapi.yaml). Conchbase owns this contract; Pagurus and other clients consume it.

## Implemented routes

| Method and path | Behavior |
|---|---|
| `GET /v1/health` | Service health and API version `1`. |
| `GET /v1/runtime` | Runtime identity, version `0.5.0`, and advertised capabilities. |
| `GET /v1/models` | Chat model ids from the configured local Magpie gateway; `502` when the catalog is unavailable. |
| `POST /v1/tasks` | Validate `prompt` and optional `model`, pin the active configuration revision, then create and start one bounded task; `202`. |
| `GET /v1/tasks` | Persisted tasks and the active configuration revision id. |
| `GET /v1/tasks/{taskId}` | One persisted task; `404` when absent. |
| `POST /v1/tasks/{taskId}/cancel` | Request cancellation of an active task; `409` when it is not active. |
| `POST /v1/tasks/{taskId}/retry` | Start a new attempt from the original prompt and pinned configuration revision for a terminal task; `409` otherwise. |
| `GET /v1/events?after=<eventId>` | Persisted events strictly after a known global event ID, plus the resulting cursor; `400` for an unknown cursor. |
| `GET /v1/configuration` | Active immutable configuration revision and versioned document. |
| `GET /v1/configuration/revisions` | Revision summaries, newest first, plus the active revision id. |
| `GET /v1/configuration/revisions/{revisionId}` | One immutable revision document; `404` when absent. |
| `POST /v1/configuration/validate` | Validate a complete candidate document without persisting it; `400` includes bounded `details`. |
| `POST /v1/configuration/apply` | Apply a complete document or roll back with `{ "rollbackTo": "cfg_..." }`; `404` for an unknown rollback id. |

A task has a stable ID, its original prompt, selected model id, pinned configuration revision, current state, attempt number, final output, current `partialOutput`, and error. `partialOutput` is visible while a v1 model task is `running` or `cancelling` and is null in terminal states; final `output` remains authoritative. States include `queued`, `running`, `cancelling`, `succeeded`, `failed`, `cancelled`, and `interrupted`. A restart changes persisted nonterminal states to `interrupted`; retry creates a visible new attempt.

Events use stable IDs and a global monotonic `sequence`. Each event records its task, type, resulting state, pinned configuration revision, attempt, and a bounded `data` object. `task.output_delta.data` contains `delta`, zero-based per-attempt `index`, and accumulated `outputLength`. Composition events carry `compositionDocumentId`, `compositionNodeId`, `nodeIndex`, `nodeCount`, `completedNodeCount`, and `terminalNodeIds` as documented in `docs/openapi.yaml` and [ADR 0016](decisions/0016-composition-execution-and-public-schema.md). Polling remains the client transport; SSE, `Last-Event-ID`, retention, and multi-process ownership remain open.

Errors use `{ "error": "message" }` with documented status codes. Validation errors return `400`; missing tasks return `404`; conflicting task operations return `409`; model-catalog failures return `502`; an unconfigured task service returns `503`.

Configuration documents use `schemaVersion: 1` or `schemaVersion: 2`. Both require bounded opaque references for Skills, policies, MCP servers, plugins, secret references, and metadata. `schemaVersion: 2` also requires a topology-neutral `composition` section with user-authored nodes, links, entry node ids, and metadata; terminal node ids and `cmp_` identity are derived by the runtime. All sections and `metadata` are required; use empty arrays or an empty object when a section is unused. `source: url` and absolute URL labels are not accepted. Documents are data, not installed capabilities or grants. A validation error returns `{ "error": "...", "details": [{ "path": "...", "reason": "..." }] }`. Applying a document creates a content-addressed immutable revision if its content is new; a no-op returns `changed: false`. Rolling back changes the active pointer without deleting history. Already-created tasks keep their pinned revision; new tasks use the active revision. A v1 task uses one streaming model turn; a v2 task uses the deterministic composition executor and makes no model call. See [ADR 0014](decisions/0014-versioned-configuration-api.md) and [ADR 0016](decisions/0016-composition-execution-and-public-schema.md).

## Boundaries

- The API is loopback-only. Remote binding requires a reviewed authentication and pairing design.
- Model ids come from the user's Magpie catalog. No model credentials enter Conchbase configuration or API responses.
- A `schemaVersion: 1` task performs one streaming text completion. Reasoning text is ignored and model-requested tools are rejected, not executed.
- A `schemaVersion: 2` task performs bounded deterministic graph traversal. It makes no model call and executes no model-requested or real host tool.
- No MCP, Skill, plugin, approval, model-driven composition, or dedicated composition management route exists yet. Composition is part of the versioned configuration document.
- Configuration document routes do not install, enable, grant, resolve secrets, load code, or execute tools.
