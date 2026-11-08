# Decision 0016: Bounded composition execution and public configuration schema

Status: **accepted product and public API direction; contracts are versioned in `docs/openapi.yaml`**

Date: 2026-11-08 (Asia/Shanghai).

## Context

[ADR 0005](0005-user-defined-agent-topology-proposal.md) records topology-neutral user-authored composition as product intent. [ADR 0014](0014-versioned-configuration-api.md) publishes `schemaVersion: 1` configuration documents with opaque references and explicitly leaves composition to a new schema version. [ADR 0015](0015-composition-identity-kernel.md) accepts an internal validator and `cmp_` identity for arbitrary directed acyclic graphs, but forbids importing the validator into `TaskService`, HTTP routes, or Pagurus until a separate public contract exists. Its sequencing direction requires composition execution identity before public tool execution.

`docs/AI_TASK_QUEUE.md` places composition execution and public schema before the public tool contract slice. A bounded deterministic execution path is needed so that node identity, pinned configuration revision, cancellation propagation, and client-visible events can be tested before approvals, audits, model-driven tool calls, or real host tools. The user's illustrative layered multi-role arrangement must remain only one possible shape; no layer count, role name, hierarchy, coordination pattern, or scheduling policy may become a built-in default.

Conchbase `0.4.0` accepts only `schemaVersion: 1` configuration documents and runs every task through one streaming Magpie turn. Pagurus `0.1.0` has a JSON configuration revision editor that mirrors that contract. Both repositories have protected `main` branches and CI that runs type checks, tests, and builds. The local Runtime API remains loopback-only and unauthenticated.

## Decision

### 1. Version and capability

The OpenAPI document, runtime status version, package version, CLI usage version, and provider `User-Agent` become `0.5.0`. The health API version remains `1`. `/v1/runtime` advertises `composition-execution` in addition to `tasks`, `events`, `models`, `streaming-output`, and `configuration-revisions`. No new route, remote binding, authentication, pairing, SSE transport, or generated client is added.

### 2. Versioned configuration union

The public `ConfigurationDocument` becomes a discriminated union:

- `schemaVersion: 1` is byte-for-byte equivalent to the ADR 0014 contract. Its canonical form and `conchbase-configuration-document-v1\0` hash prefix are unchanged. A v1 document with a `composition` field remains invalid. Bootstrap remains v1.
- `schemaVersion: 2` requires all v1 fields plus a required `composition` section. It uses a `conchbase-configuration-document-v2\0` hash prefix. Applying or rolling back v2 documents uses the existing immutable revision history; existing tasks keep their pinned revision id.

The public `composition` section carries only user-authored data: `schemaVersion: 1`, `name`, `nodes`, `links`, `entryNodeIds`, and `metadata`. Nodes have bounded `id` and `label`; links have bounded `id`, `from`, `to`, and `label`. Link labels are opaque data. The runtime validates arbitrary single-node and multi-node directed acyclic graphs using the accepted internal identity kernel, computes terminal node IDs, and computes `cmp_` identity from the canonical composition document. Derived terminal IDs and `cmp_` identity are not accepted as client input in the configuration document and are not persisted as configuration fields. `compositionDocumentId` appears in composition events; terminal IDs appear in deterministic output and composition event data.

`schemaVersion` values other than `1` or `2` are invalid. There is no silent upgrade, downgrade, partial merge, or reinterpretation of v1. All validation errors keep the bounded field-addressable `details` shape; composition validation issues are prefixed with `composition.`.

### 3. Deterministic task dispatch

`POST /v1/tasks` keeps its existing request shape. `TaskService.createTask` continues to pin the active configuration revision. On start, `TaskService` reads the pinned immutable revision and dispatches:

- `schemaVersion: 1` keeps the existing single-turn streaming Magpie path, durable `task.output_delta` events, `partialOutput`, cancellation, and explicit retry.
- `schemaVersion: 2` runs a deterministic, topology-neutral composition executor. It makes no model-provider request, emits no `task.output_delta`, does not use `partialOutput`, never executes a model-requested tool or real host tool, and never loads a Skill/MCP/plugin. Retry re-runs the same pinned v2 document from the start.

The executor computes one deterministic topological node order from sorted entry nodes, sorted link targets, and a lexicographically sorted ready set. This is an execution-order rule for the bounded deterministic slice, not a concurrency, delegation, scheduling, authority, or product-topology contract. Single-node, chain, fan-out/fan-in, and multiple-entry DAGs are all valid fixtures. Final output is `composition:<compositionDocumentId>:<comma-separated terminal node ids>`; it is derived only from the pinned revision, not from prompt text or a provider response.

### 4. Event identity and cancellation

The public event envelope remains `{ sequence, id, taskId, type, state, configurationRevisionId, attempt, data }`. No SQLite column migration is needed. Composition node identity lives in bounded scalar fields inside `data`:

- `composition.started`: `compositionDocumentId`, `nodeCount`, `terminalNodeIds`.
- `composition.node_started`, `composition.node_completed`, `composition.node_cancelled`: `compositionDocumentId`, `compositionNodeId`, `nodeIndex`, `nodeCount`.
- `composition.completed`: `compositionDocumentId`, `nodeCount`, `completedNodeCount`, `terminalNodeIds`.
- `composition.cancelled`: `compositionDocumentId`, `nodeCount`, `completedNodeCount`.

All composition events carry the task's pinned `configurationRevisionId` and `attempt` in the existing envelope. A successful v2 task emits `task.queued`, `task.started`, `composition.started`, ordered node events, `composition.completed`, and `task.completed`. Cancellation checks the abort signal before each node and after node start. On cancellation it records a node cancellation event for the node that will not complete, then `composition.cancelled` and `task.cancelled`; no later node starts or completes. A cancellation requested before `task.started` remains the existing `task.cancellation_requested` and `task.cancelled` behavior. Terminal task state and its event still commit together; composition progress events commit individually through one narrow `TaskStore.recordEvent` boundary.

`TaskEventType` gains `composition.started`, `composition.node_started`, `composition.node_completed`, `composition.node_cancelled`, `composition.completed`, and `composition.cancelled`. Tool-prefixed internal event names remain unexposed.

### 5. Client direction

Pagurus adds an accepted ADR 0005 and a typed v1/v2 configuration client. It validates the public composition section shape at its HTTP boundary but does not compute graph identity or define a second schema. It uses the same five published configuration routes and the same write set. A runtime with `configuration-revisions` but without `composition-execution` can still read and edit v1 documents; v2 apply attempts show an explicit unsupported state. Pagurus may edit v2 documents as JSON, but does not add a visual composition builder, built-in template, role registry, layer count, or coordination pattern in this slice.

### 6. Security and non-goals

Conchbase remains the execution authority. No UI reads or writes private runtime files or database tables. Loopback-only binding and the single-owner SQLite boundary are unchanged. The composition executor does not grant tools, load code, resolve secrets, start MCP servers, or interpret labels as authority. A Skill never grants tools. Public tool approvals, durable audits, provider tool-call parsing, crash-safe side effects, real executor isolation, multi-turn model context, automatic continuation of in-flight work after a crash, production migrations, SSE, retention, authentication, and remote pairing remain out of scope.

## Options

### A. Public tool contract first

Consequences: quicker real-tool demo, but approvals, audits, and idempotency keys would be scoped to flat task identity. Adding composition node identity later would break those public contracts. Rejected by ADR 0015 and retained as rejected here.

### B. Full model-driven composition now

Consequences: one model call per node and visually richer output, but requires provider tool-call parsing, per-node model selection, context passing, approvals, durable audits, crash-safe side effects, and executor isolation before identity and cancellation are proven. Weaker models could hardcode the illustrative layered example. Rejected because it settles security and coordination contracts too early.

### C. Versioned deterministic composition execution first (recommended)

Consequences: accepts the minimum public schema and event identity, proves arbitrary topology-neutral DAGs and cancellation with deterministic fixtures, and leaves tool/security contracts open. It adds a v2 task mode that does not call a model, so clients must read runtime capabilities and configuration schema versions rather than assume every task produces streamed answer text. This is the accepted direction.

### D. Add dedicated composition write and execution routes

Consequences: explicit URLs for composition management, but duplicates the accepted configuration revision API and expands the public write surface before authentication exists. Rejected; existing `validate`/`apply`/rollback and task routes are sufficient for this slice.

## Consequences

The OpenAPI contract becomes `0.5.0` with a `ConfigurationDocument` union and documented composition event data, but the accepted path set remains exactly thirteen routes. Clients that assumed `schemaVersion` was always `1` must update. v1 revision IDs, task output, and event history remain stable. New v2 revisions are content-addressed with their own versioned hash prefix; rollback can mix v1 and v2 history without rewriting rows.

Public tool approvals and audits can now be designed around `configurationRevisionId`, `compositionDocumentId`, `compositionNodeId`, and `attempt` rather than a flat task scope. ADR 0013's internal approval record remains insufficient and unchanged. ADR 0005 remains a proposal for broader coordination semantics; this ADR accepts one bounded public graph representation and deterministic execution rule, not a general multi-agent scheduling product.

Repository guardrails are updated in the same slice to accept ADR 0016, require the `0.5.0` contract, keep the exact path set and loopback-only server, allow `configuration-document.ts` and `composition-execution.ts` as the validation/execution owners of the internal identity kernel, and continue rejecting hardcoded topology names, tool execution in the HTTP path, private-file access from HTTP, and unaccepted dependencies.

## Validation

- Pure validator tests cover v1 stability, v2 composition validation, v1/v2 canonicalization, malformed composition issues, unsupported schema versions, missing sections, and secret-like values.
- SQLite tests cover mixed v1/v2 history, no-op applies, restart persistence, rollback, and task revision pinning.
- Composition execution tests cover a single node, a chain, a fan-out/fan-in graph, and multiple entry nodes; event order, node identity, pinned `cmp_` id, deterministic output, no model-provider call, retry from the original pinned v2 revision, and cancellation propagation without later node completion.
- Fastify injection tests cover v1/v2 configuration validation and apply, runtime version/capability, exact route set, and unavailable-service behavior.
- Pagurus client/component/guardrail tests cover the v1/v2 union, composition section shape validation, v2 apply, unsupported older runtime, unchanged write routes, and no visual builder or second schema.
- Both repositories run `npm run check`, `npm test`, and `npm run build`. CI uses no real credential, user data, public-network dependency, real model, or real tool.
