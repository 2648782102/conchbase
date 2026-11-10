# Runtime API status

The service listens on `127.0.0.1:4318` by default. The machine-readable source of truth for all routes is [`openapi.yaml`](openapi.yaml). Conchbase owns this contract; Pagurus and other clients consume it.

## Implemented routes

| Method and path | Behavior |
|---|---|
| `GET /v1/health` | Service health and API version `1`. |
| `GET /v1/runtime` | Runtime identity, version `1.0.0`, and advertised capabilities including `durable-work-contract`. |
| `GET /v1/models` | Chat model ids from the configured local Magpie gateway; `502` when the catalog is unavailable. |
| `GET /v1/model-catalog` | Provider-neutral model references with normalized capabilities; currently the `magpie` compatibility adapter; `502` when unavailable. |
| `GET /v1/agents` | Runtime-local Agent collection and current revisions. |
| `POST /v1/agents` | Validate model availability and create an Agent plus initial immutable revision; `201`. |
| `GET /v1/agents/{agentId}` | Read an Agent and all its revisions; `404` when absent. |
| `PATCH /v1/agents/{agentId}` | Append a profile revision using `expectedRevisionId`; stale edits return `409`. |
| `POST /v1/agents/{agentId}/duplicate` | Create a new Agent identity from a selected revision; `201`. |
| `POST /v1/agents/{agentId}/archive` | Soft archive; preserves tasks/revisions, clears default, and blocks new tasks. |
| `GET /v1/agents/{agentId}/revisions` | Read the immutable revision history. |
| `POST /v1/agents/{agentId}/revisions/apply` | Roll back by appending a new revision from history with optimistic concurrency. |
| `GET /v1/agents/default` | Read the default Agent or `null`. |
| `PUT /v1/agents/default` | Set a non-archived default Agent or clear the default with `null`. |
| `POST /v1/tasks` | Accept either legacy `{ prompt, model? }` or Agent `{ prompt, agentId, modelOverride? }`; pin the active configuration and (for Agent tasks) Agent revision plus effective provider/model; create and start; `202`. |
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
| `POST /v1/provider-observations/tool-calls` | Normalize one bounded OpenAI Chat Completions-compatible non-streaming function tool call into a transient observation; `200`, including `observation: null` when no tool call is present. No state, ledger request, event, or tool execution. |
| `POST /v1/work/triggers` | Idempotently ingest one bounded fake/manual Trigger; `201` for a new Trigger, `200` for exact replay, `409` for a conflict. Creates one immutable Mandate and one open WorkItem per Thread, pins one planned Assignment, and records digest-only Outbox/DeliveryReceipt evidence. No model, tool, external write, or secret resolution. |
| `GET /v1/work/items` | List durable WorkItems and their current state. |
| `GET /v1/work/items/{workItemId}` | Read one WorkItem with its context-only Thread, immutable Mandate, planned Assignments, pending Outbox records, and observed DeliveryReceipts; `404` when absent. |
| `GET /v1/work/delivery-receipts` | List digest-only delivery evidence across durable WorkItems. |
| `POST /v1/work/delivery-receipts/{receiptId}/decision` | Record `accepted` or `rejected` on an observed receipt; `409` after a decision. |
| `POST /v1/work/assignments/{assignmentId}/reconcile` | Resolve an interrupted assignment as `succeeded` or `failed`; `409` for other states. |
| `POST /v1/work/items/{workItemId}/start` | Start or resume a WorkItem from its exact expected state. |
| `POST /v1/work/items/{workItemId}/stop` | Stop a running or paused WorkItem. |
| `POST /v1/work/items/{workItemId}/complete` | Complete a running WorkItem and mark bounded evidence delivered/accepted. |
| `GET /v1/work/events` | Read bounded durable work, Source, capability, pairing, token, and SecretHandle evidence events. |
| `GET /v1/auth/pairings` | List pairing sessions; values are challenge digests and metadata only. |
| `POST /v1/auth/pairings` | Create a pending pairing session; `201`. |
| `POST /v1/auth/pairings/approve` | Approve a pairing by exact challenge digest; `409` on mismatch. |
| `POST /v1/auth/pairings/{pairingId}/revoke` | Revoke a pairing and its tokens. |
| `GET /v1/auth/tokens` | List token records; only digests and metadata are returned. |
| `POST /v1/auth/tokens` | Register a token digest for an approved pairing; `201`. |
| `POST /v1/auth/tokens/{tokenId}/revoke` | Revoke one token record. |
| `GET /v1/sources/local/events` | List bounded local Source evidence. |
| `POST /v1/sources/local/events` | Ingest a deterministic `allow`/`deny` Source event; allowed events may start matching work. |
| `GET /v1/capabilities` | List bounded capability directory records. |
| `POST /v1/capabilities` | Upsert one `mcp`, `skill`, `plugin`, or `secret-handle` directory record; `201`. Records do not grant execution. |
| `GET /v1/secret-handles` | List digest-only handle metadata; no value, cipher, IV, or tag is returned. |
| `POST /v1/secret-handles` | Register one write-only value; `201`. |
| `POST /v1/secret-handles/{handleId}/rotate` | Rotate to another one-shot value and increment `secretVersion`. |
| `POST /v1/secret-handles/{handleId}/status` | Set `active` or `disabled`. |
| `POST /v1/secret-handles/{handleId}/use` | Invoke the runtime-owned fixed adapter with pinned identities; returns a digest-only `injected`/`denied` receipt. |
| `GET /v1/secret-handles/use-receipts` | List digest-only use receipts. |

An Agent profile is a versioned resource with bounded name, instructions, and `{ providerId, modelId }` default model reference. It contains no credential, provider URL, permission, or tool grant. The first Agent becomes default; there is no implicit default selection for task creation. Profile edits and history apply use `expectedRevisionId`; rollback appends a revision. Archiving is soft and irreversible in the current API, preserves history, and prevents new tasks. Existing tasks, including retries, stay bound to their pinned revision.

A task has a stable ID, its original prompt, selected model id, pinned configuration revision, current state, attempt number, final output, current `partialOutput`, and error. Agent tasks also expose `agentId`, `agentRevisionId`, `providerId`, and `modelId`; the queued event carries the same identity. `model` and `modelOverride` cannot be combined with Agent mode; `modelOverride` cannot be sent without `agentId`. Agent tasks always use one model turn through their pinned provider/model even if the active runtime configuration is v2. Legacy tasks keep their old global v1/v2 dispatch and request shape. `partialOutput` is visible while a v1 model task is `running` or `cancelling` and is null in terminal states; final `output` remains authoritative. States include `queued`, `running`, `cancelling`, `succeeded`, `failed`, `cancelled`, and `interrupted`. A restart changes persisted nonterminal states to `interrupted`; retry creates a visible new attempt.

Events use stable IDs and a global monotonic `sequence`. Each event records its task, type, resulting state, pinned configuration revision, attempt, and a bounded `data` object. `task.output_delta.data` contains `delta`, zero-based per-attempt `index`, and accumulated `outputLength`. Composition events carry `compositionDocumentId`, `compositionNodeId`, `nodeIndex`, `nodeCount`, `completedNodeCount`, and `terminalNodeIds` as documented in `docs/openapi.yaml` and [ADR 0016](decisions/0016-composition-execution-and-public-schema.md). Public tool ledger events carry `toolRequestId`, `configurationRevisionId`, `attempt`, `compositionDocumentId`, `compositionNodeId`, `toolName`, `argumentsDigest`, `idempotencyKey`, `status`, and decision-only `decision`, `approvalId`, and `reasonDigest` fields. They do not transition task state and never claim execution. Polling remains the client transport; SSE, `Last-Event-ID`, retention, and multi-process ownership remain open.

Errors use `{ "error": "message" }` with documented status codes. Validation errors return `400`; missing resources return `404`; conflicting task or Agent operations return `409`; model-catalog failures return `502`; an unconfigured task service returns `503`.

Configuration documents use `schemaVersion: 1` or `schemaVersion: 2`. Both require bounded opaque references for Skills, policies, MCP servers, plugins, secret references, and metadata. `schemaVersion: 2` also requires a topology-neutral `composition` section with user-authored nodes, links, entry node ids, and metadata; terminal node ids and `cmp_` identity are derived by the runtime. All sections and `metadata` are required; use empty arrays or an empty object when a section is unused. `source: url` and absolute URL labels are not accepted. Documents are data, not installed capabilities or grants. A validation error returns `{ "error": "...", "details": [{ "path": "...", "reason": "..." }] }`. Applying a document creates a content-addressed immutable revision if its content is new; a no-op returns `changed: false`. Rolling back changes the active pointer without deleting history. Already-created tasks keep their pinned revision; new tasks use the active revision. A v1 task uses one streaming model turn; a v2 task uses the deterministic composition executor and makes no model call. See [ADR 0014](decisions/0014-versioned-configuration-api.md) and [ADR 0016](decisions/0016-composition-execution-and-public-schema.md).

Tool request documents are provider-neutral data. A request includes `taskId`, `attempt`, `compositionNodeId`, and `toolCall` with a bounded `toolName` and scalar `arguments`. The runtime requires a v2 task in `queued`, `running`, or `waiting_approval`, derives `cmp_` identity and the pinned configuration revision, validates the node, stores an arguments digest and a composition-scoped idempotency key, and returns a pending record. An approval includes only `decision` and a bounded `reason`; the runtime stores a reason digest. Exact replay returns the same record without adding events; a conflicting decision returns `409`. See [ADR 0017](decisions/0017-public-tool-request-approval-ledger.md).

Provider observation documents are transient, untrusted normalization inputs. A request has `version: 1`, `provider: 'openai-chat-completions'`, and one bounded plain-JSON `payload`. The route returns a `version: 1` observation with `providerToolCallId`, a normalized `toolCall`, and an `argumentsDigest`, or `null` for a no-tool-call response. It rejects unsupported providers, raw envelope fields, secret-like or absolute-URL data, streaming deltas, mixed answers, multiple calls, and malformed shapes with bounded `details`. A client that wants a durable ledger record must explicitly submit the normalized `toolCall` to `POST /v1/tool-requests` with task, attempt, and composition node identity. See [ADR 0019](decisions/0019-explicit-provider-tool-call-observation-boundary.md).

Durable work documents are deterministic, topology-neutral state from [ADR 0024](decisions/0024-durable-work-domain-and-public-api.md) and [ADR 0025](decisions/0025-local-first-v1-platform.md). A Trigger request contains bounded `source`, `trigger`, `mandate`, provider-neutral `model`, and pinned revision ids; all digests are `sha256:<64 lowercase hex>`. `POST /v1/work/triggers` parses its raw `application/json` body and delegates exact shape validation to the pure domain contract, so top-level or nested unknown fields, malformed JSON, and unsupported shape changes return `400` before persistence. The `trigger.triggerId` is stored as `sourceEventId`, while the Runtime derives an opaque `trg_` id. An exact replay returns the stored envelope without new rows or events. A later Trigger with the same `threadKey` must carry the same Mandate and Assignment proposal; it adds context to the Thread but creates no second WorkItem, Mandate, Assignment, Outbox record, or DeliveryReceipt. A changed proposal returns `409`. Version-2 WorkItem, Assignment, Outbox, and DeliveryReceipt states have widened enums; all evidence remains digest-only and is not proof of an external write. The runtime advertises `durable-work-contract`, `authenticated-pairing`, `asynchronous-work-control`, `local-source-policy`, `capability-directory`, and `write-only-secret-handles`; clients must gate features on those capabilities. ADR 0025 adds start/stop/complete, recovery, delivery decisions, local Source events, capability records, and write-only SecretHandle routes.

## Boundaries

- The API defaults to loopback-only. Remote binding requires explicit authenticated pairing and an approved token digest.
- Legacy model ids come from the user's Magpie catalog. Agent profiles and the new model catalog use provider-neutral references; only the `magpie` adapter is currently registered. No model credentials enter Agent documents or API responses.
- A `schemaVersion: 1` task performs one streaming text completion. Reasoning text is ignored and model-requested tools are rejected, not executed.
- The ADR 0018 parser is wired into the provider and the transient observation route by ADR 0019. A whole message-shaped tool call becomes a transient observation; streaming deltas and unsupported shapes remain rejected. No observation creates a ledger request, task transition, event, or execution permission.
- A legacy `schemaVersion: 2` task performs bounded deterministic graph traversal. It makes no model call and executes no model-requested or real host tool. Agent-backed tasks use a single model turn and do not implicitly execute the global composition graph.
- No public tool execution, executable approval, real MCP/Skill/plugin lifecycle, model-driven composition, or dedicated composition management route exists yet. Capability records are configuration data. Composition is part of the versioned configuration document; the tool request/approval routes are ledger records only.
- Configuration document routes do not install, enable, grant, resolve secrets, load code, or execute tools.
- Tool request and approval routes do not execute tools, transition task state, load code, resolve secrets, or grant capabilities.
- Work and platform routes do not call a model, execute a host tool, perform an external write, expose a generic secret resolver, read a private file from a client, define a canonical topology, or reinterpret the phase-1 `Task` resource. A submitted SecretHandle value is sealed with a process-scoped key and is exposed only to one runtime-owned fixed adapter; restart invalidates old sealed values.

> Final local-first target: Conchbase `1.0.0` and ADR 0025 close the exact 47-path platform contract. Write-only SecretHandle values are sealed at rest with a process-scoped AES-256-GCM key, exposed only to one runtime-owned fixed adapter, and never returned, logged, or sent to a model, client, event, or UI. Restart invalidates previously sealed values; cross-process key sources, real external adapters, executors, Sources, external writes, and tools require separate ADRs.
