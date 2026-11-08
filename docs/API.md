# Runtime API status

The service listens on `127.0.0.1:4318` by default. The machine-readable source of truth for all routes is [`openapi.yaml`](openapi.yaml). Conchbase owns this contract; Pagurus and other clients consume it.

## Implemented routes

| Method and path | Behavior |
|---|---|
| `GET /v1/health` | Service health and API version `1`. |
| `GET /v1/runtime` | Runtime identity, version `0.6.0`, and advertised capabilities. |
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
| `POST /v1/tool-requests` | Create one normalized tool request ledger record for an eligible `schemaVersion: 2` task attempt; `201`, or `200` for exact replay. No tool is executed. |
| `GET /v1/tool-requests/{requestId}` | Read one durable tool request record; `404` when absent. |
| `POST /v1/tool-requests/{requestId}/approval` | Record one explicit `approved` or `rejected` decision; `201`, or `200` for exact replay, `409` for a conflicting decision. No tool is executed. |

A task has a stable ID, its original prompt, selected model id, pinned configuration revision, current state, attempt number, final output, current `partialOutput`, and error. `partialOutput` is visible while a v1 model task is `running` or `cancelling` and is null in terminal states; final `output` remains authoritative. States include `queued`, `running`, `cancelling`, `succeeded`, `failed`, `cancelled`, and `interrupted`. A restart changes persisted nonterminal states to `interrupted`; retry creates a visible new attempt.

Events use stable IDs and a global monotonic `sequence`. Each event records its task, type, resulting state, pinned configuration revision, attempt, and a bounded `data` object. `task.output_delta.data` contains `delta`, zero-based per-attempt `index`, and accumulated `outputLength`. Composition events carry `compositionDocumentId`, `compositionNodeId`, `nodeIndex`, `nodeCount`, `completedNodeCount`, and `terminalNodeIds` as documented in `docs/openapi.yaml` and [ADR 0016](decisions/0016-composition-execution-and-public-schema.md). Public tool ledger events carry `toolRequestId`, `configurationRevisionId`, `attempt`, `compositionDocumentId`, `compositionNodeId`, `toolName`, `argumentsDigest`, `idempotencyKey`, `status`, and decision-only `decision`, `approvalId`, and `reasonDigest` fields. They do not transition task state and never claim execution. Polling remains the client transport; SSE, `Last-Event-ID`, retention, and multi-process ownership remain open.

Errors use `{ "error": "message" }` with documented status codes. Validation errors return `400`; missing tasks return `404`; conflicting task operations return `409`; model-catalog failures return `502`; an unconfigured task service returns `503`.

Configuration documents use `schemaVersion: 1` or `schemaVersion: 2`. Both require bounded opaque references for Skills, policies, MCP servers, plugins, secret references, and metadata. `schemaVersion: 2` also requires a topology-neutral `composition` section with user-authored nodes, links, entry node ids, and metadata; terminal node ids and `cmp_` identity are derived by the runtime. All sections and `metadata` are required; use empty arrays or an empty object when a section is unused. `source: url` and absolute URL labels are not accepted. Documents are data, not installed capabilities or grants. A validation error returns `{ "error": "...", "details": [{ "path": "...", "reason": "..." }] }`. Applying a document creates a content-addressed immutable revision if its content is new; a no-op returns `changed: false`. Rolling back changes the active pointer without deleting history. Already-created tasks keep their pinned revision; new tasks use the active revision. A v1 task uses one streaming model turn; a v2 task uses the deterministic composition executor and makes no model call. See [ADR 0014](decisions/0014-versioned-configuration-api.md) and [ADR 0016](decisions/0016-composition-execution-and-public-schema.md).

Tool request documents are provider-neutral data. A request includes `taskId`, `attempt`, `compositionNodeId`, and `toolCall` with a bounded `toolName` and scalar `arguments`. The runtime requires a v2 task in `queued`, `running`, or `waiting_approval`, derives `cmp_` identity and the pinned configuration revision, validates the node, stores an arguments digest and a composition-scoped idempotency key, and returns a pending record. An approval includes only `decision` and a bounded `reason`; the runtime stores a reason digest. Exact replay returns the same record without adding events; a conflicting decision returns `409`. See [ADR 0017](decisions/0017-public-tool-request-approval-ledger.md).

## Boundaries

- The API is loopback-only. Remote binding requires a reviewed authentication and pairing design.
- Model ids come from the user's Magpie catalog. No model credentials enter Conchbase configuration or API responses.
- A `schemaVersion: 1` task performs one streaming text completion. Reasoning text is ignored and model-requested tools are rejected, not executed.
- The internal ADR 0018 provider tool-call parser is pure and unwired. It adds no API route, provider adapter behavior, task state change, event type, or execution permission; model-requested tools remain rejected.
- A `schemaVersion: 2` task performs bounded deterministic graph traversal. It makes no model call and executes no model-requested or real host tool.
- No public tool execution, executable approval, MCP, Skill, plugin, model-driven composition, or dedicated composition management route exists yet. Composition is part of the versioned configuration document; the tool request/approval routes are ledger records only.
- Configuration document routes do not install, enable, grant, resolve secrets, load code, or execute tools.
- Tool request and approval routes do not execute tools, transition task state, load code, resolve secrets, or grant capabilities.
