# Decision 0017: Public tool request/approval ledger without execution

Status: **accepted product and public API direction; contracts are versioned in `docs/openapi.yaml`**

Date: 2026-11-08 (Asia/Shanghai).

## Context

[ADR 0013](0013-bounded-tool-capability-kernel.md) accepts an internal, fixture-only tool capability kernel. It deliberately does not expose tool routes, persist approvals, or execute real host tools. [ADR 0015](0015-composition-identity-kernel.md) records that composition execution identity must precede public tool execution. [ADR 0016](0016-composition-execution-and-public-schema.md) publishes `schemaVersion: 2` configuration documents, pins `cmp_` identity to tasks, emits node events, and requires future public tool approvals, idempotency keys, and audits to include `configurationRevisionId`, `compositionDocumentId`, `compositionNodeId`, and attempt.

`docs/AI_TASK_QUEUE.md` places a public tool contract slice next. The full slice names provider tool-call parsing, approval endpoints, durable audit storage, crash-safe side effects, and real executor isolation. Accepting all of those at once would settle executor trust, provider-specific tool-call semantics, side-effect recovery, and authorization UX before the public identity has a durable representation. The local Runtime API remains loopback-only and unauthenticated, so a tool execution endpoint would be an unsafe shortcut.

This ADR accepts the minimum public contract needed to make tool decisions inspectable and durable before any executor exists. It treats a tool request as a versioned ledger record, not as permission to execute. Conchbase remains the execution authority; Pagurus and other clients can later submit or approve requests through the published API, but no UI reads the private database.

## Decision

### 1. Version and capability

The OpenAPI document, runtime status version, package version, CLI usage version, and provider `User-Agent` become `0.6.0`. The health API version remains `1`. `/v1/runtime` advertises `tool-approval-ledger` in addition to the existing capabilities. The accepted path set becomes sixteen routes; no route is removed or silently reinterpreted.

Three routes are added:

- `POST /v1/tool-requests` creates one normalized, provider-neutral tool request for an eligible task attempt.
- `GET /v1/tool-requests/{requestId}` reads one durable request record.
- `POST /v1/tool-requests/{requestId}/approval` records one explicit `approved` or `rejected` decision.

There is no tool execution route, tool listing route, registration route, MCP lifecycle route, Skills loader route, plugin host route, secret resolution route, or generated client. No remote binding, authentication, pairing, SSE transport, or new runtime dependency is added.

### 2. Normalized tool call proposal

The public request carries `taskId`, `attempt`, `compositionNodeId`, and `toolCall`. `toolCall` has bounded `toolName` and `arguments` scalar fields. Raw provider tool-call payloads, provider response bodies, reasoning text, raw arguments, credentials, secret-like values, and absolute URLs are not accepted. Provider adapters must later normalize a structured tool call into this provider-neutral shape through a separate accepted adapter ADR; the public API does not depend on OpenAI, Magpie, MCP, or any vendor schema.

The runtime validates the tool name, argument keys, argument scalar values, argument count, and string bounds. It stores only an `arg_` arguments digest, never raw arguments. A Skill, plugin manifest, MCP server label, or model message never grants a tool or changes this validation.

### 3. Durable identity

Only a task pinned to a `schemaVersion: 2` configuration revision can create a tool request. The task must be `queued`, `running`, or `waiting_approval`, and the request `attempt` must equal the task's current attempt. The runtime derives `compositionDocumentId` from the pinned immutable composition and rejects a `compositionNodeId` that is not one of its nodes.

Every request has `version: 1`, a `tqr_` id, `configurationRevisionId`, `attempt`, `compositionDocumentId`, `compositionNodeId`, `toolName`, `argumentsDigest`, and an `idem_` idempotency key derived from that full identity. The key is stable for the same identity and distinct when task, attempt, revision, composition document, node, tool name, or arguments digest changes. Repeating the same request returns the existing record with `created: false` and adds no event.

Approval records use versioned request identity, not the ADR 0013 flat approval shape. An approval has a `tap_` id, a decision, a `rsn_` reason digest, and a decision timestamp in the same durable request row. Raw approval reasons are not stored or returned. Repeating the same decision and reason digest returns `changed: false`; a conflicting decision returns `409`.

### 4. Durable audit events and task-state boundary

`SqliteTaskStore` gains a `tool_requests` table. Creating a request commits the row and two durable events in one transaction: `tool.requested` and `tool.approval_required`. A decision commits the updated row and exactly one `tool.approved` or `tool.rejected` event. Existing `/v1/events` polling exposes these events; no new transport or event envelope is added.

Event data carries bounded scalars: `toolRequestId`, `configurationRevisionId`, `attempt`, `compositionDocumentId`, `compositionNodeId`, `toolName`, `argumentsDigest`, `idempotencyKey`, `status`, and, for decisions, `decision`, `approvalId`, and `reasonDigest`. Raw arguments, raw reasons, tool outputs, provider payloads, and credentials never enter event data.

Tool request events use the task's current state and do not transition the task state machine. They are ledger events, not evidence that a tool ran. `tool.executed`, `tool.failed`, `tool.denied`, and `tool.replayed` remain internal deterministic-test vocabulary. No public event claims execution, replay, denial, or failure of a side effect.

### 5. Security and non-goals

Conchbase remains the execution authority. No UI reads or writes private runtime files or database tables. Loopback-only binding and the single-owner SQLite boundary are unchanged. `ToolCapabilityKernel` remains an internal fixture-only module; the public ledger uses a separate `tool-request.ts` boundary and does not import it. A request or approval never invokes an executor, starts an MCP server, loads a Skill or plugin, resolves a secret, or grants per-tool authority.

Provider tool-call parsing from model responses, model-driven tool execution, multi-turn tool loops, per-node model selection, crash-safe side effects, real executor isolation, durable execution results, production approval UX, remote approval, MCP lifecycle, and authentication/pairing remain out of scope. Automatic continuation of an in-flight side effect after a crash is not implemented because no side effect exists. A later ADR must accept each boundary before `ToolCapabilityKernel` or any real host adapter is connected to the public API.

Pagurus adds no tool-request UI or write route in this slice. Its current five published write routes remain unchanged. A future client ADR must define approval states, keyboard access, and exact runtime capability handling before Pagurus consumes these routes.

## Options

### A. Full public tool execution now

Consequences: visible real-tool demo, but requires executor isolation, crash-safe side effects, provider tool-call parsing, approval UX, per-tool grants, and authentication before any public identity is durable. Rejected because it settles the most security-sensitive contracts too early.

### B. Keep the internal kernel only

Consequences: no public change, but later tool approvals would be designed around in-memory fixtures and could omit composition node identity, pinned revision, durable audit, and client-visible decision states. Rejected by ADR 0015 and ADR 0016.

### C. Public request/approval ledger first (recommended)

Consequences: locks the versioned public identity, durable approval storage, durable audit events, idempotency, and client read/decision contract while keeping execution blocked. It adds three routes and one private table, but no executor or provider dependency. Weaker models get an executable boundary that says a ledger decision is not tool permission. This is the accepted direction.

### D. Add a generic capabilities management API now

Consequences: exposes install/enable/grant operations before registry trust, plugin isolation, MCP lifecycle, secret resolution, and authentication are accepted. Rejected; ADR 0007 keeps those schemas open.

## Consequences

The OpenAPI contract becomes `0.6.0` with sixteen paths. Existing task, event, model, and configuration routes keep their shapes. The `RuntimeEvent.type` enum adds the four public ledger event names and excludes internal execution, replay, denial, and failure vocabulary; event `data` documentation names the public ledger's bounded scalars. v1/v2 configuration documents, bootstrap revisions, composition execution, cancellation, and retry are unchanged. Public tool requests are available only for v2 task attempts in `queued`, `running`, or `waiting_approval`, so v1 tasks remain single-turn and reject model-requested tools.

The public ledger makes `configurationRevisionId`, `compositionDocumentId`, `compositionNodeId`, and attempt part of approval and audit identity before a real executor exists. ADR 0013's internal approval record remains insufficient and unchanged. ADR 0005 remains a proposal for broader coordination semantics; this ADR does not define delegation, concurrency, role registries, or a canonical topology.

Repository guardrails are updated in the same slice to accept ADR 0017, require the `0.6.0` contract and sixteen-path set, keep the loopback-only server and dependency baseline, and reject public execution vocabulary, raw arguments, private-file access from HTTP, and importing `ToolCapabilityKernel` into the public ledger. Pagurus documents the runtime capability as read-only client context and keeps tool approval UI planned.

## Validation

- Pure validator tests cover normalized tool-call validation, secret-like and absolute-URL rejection, versioned identity digest stability, approval input validation, and reason digest normalization.
- SQLite tests cover request creation, durable events, read-after-restart, exact idempotent replay with no extra events, approval decisions, idempotent decisions, conflicting decisions, unknown requests, v1 configuration rejection, wrong attempt, terminal task, and unknown composition nodes.
- Fastify injection tests cover the three new routes, exact status codes, bounded validation errors, runtime capability, the exact sixteen-path OpenAPI contract, and unavailable-service behavior.
- Repository guardrails check that the public ledger never imports `ToolCapabilityKernel`, never exposes `tool.executed`, and never stores raw arguments or reasons.
- Both repositories run `npm run check`, `npm test`, and `npm run build`. CI uses no real credential, user data, public-network dependency, real model, real tool, or provider SDK.
