# Decision 0015: Internal composition identity kernel

Status: **accepted internal architecture direction; no public API contract changes**

Date: 2026-11-08 (Asia/Shanghai).

## Context

[ADR 0005](0005-user-defined-agent-topology-proposal.md) accepts topology-neutral user-authored composition as product intent and leaves the public schema, identity, validation, delegation, concurrency, cancellation propagation, and topology representation open. [ADR 0010](0010-first-real-model-slice.md) implements a single-turn execution unit for real-model validation. [ADR 0014](0014-versioned-configuration-api.md) publishes a `schemaVersion: 1` configuration document that deliberately contains opaque references and no composition section.

[ADR 0013](0013-bounded-tool-capability-kernel.md) accepts an internal, fixture-only tool capability kernel. Its approval records are scoped to `taskId`, `attempt`, `toolName`, and `argumentsDigest`; they have no composition node identity. `docs/AI_TASK_QUEUE.md` currently puts the public tool contract first, but exposing tool execution before an execution subject exists would lock approval records, audit events, and cancellation semantics around a flat task identity. Later adding multi-node compositions would require breaking those contracts.

The current CLI also takes short-lived ownership of the private SQLite database for task-state and configuration reads. `docs/AI_HANDOFF.md` and `docs/AI_TASK_QUEUE.md` currently overstate API parity by saying every client and the CLI use the Runtime API. [ADR 0011](0011-phase-one-database-instance-ownership.md) documents the direct CLI boundary, and the queue keeps an authoritative client API open.

This ADR accepts a narrow internal composition identity kernel and records the sequencing needed before any public composition or tool contract. It does not add a route, change a configuration schema, execute a model or tool, grant capability, or alter runtime state.

## Decision

### 1. Internal identity document

Add `src/runtime/composition-document.ts` as an internal validator and identity module. It accepts a plain object with `schemaVersion: 1`, a bounded `name`, `nodes`, `links`, `entryNodeIds`, and required `metadata`. Nodes have bounded user-authored `id` and `label` values. Links have bounded user-authored `id`, `from`, `to`, and `label` values. Link labels are opaque data; the validator does not interpret them as delegation, scheduling, sequencing, or authority.

The validator canonicalizes and sorts nodes, links, entry IDs, and metadata keys. A versioned SHA-256 digest yields a `cmp_` identity. It rejects unknown fields, missing sections, duplicate IDs, duplicate links between the same node pair, self-links, unknown endpoints, credential-like identifiers or labels, secret-like values, absolute URLs, and excessive sizes.

### 2. Structural invariants

Treat the input as a directed acyclic graph for this internal boundary. `entryNodeIds` must list exactly the nodes without incoming links. Terminal IDs are computed from nodes without outgoing links. Every node must be reachable from an entry node. Cycles and disconnected components are rejected with field-addressable issues.

These are structural validation rules for deterministic fixtures. They do not define a layer count, role name, hierarchy, coordination pattern, execution order, concurrency policy, scheduling strategy, or delegation semantics. A single node, a chain, a fan-out/fan-in graph, and a graph with multiple entry nodes are all valid shapes. Cyclic coordination remains a future schema and execution decision.

### 3. Capability and execution boundaries

The document carries identity only. It contains no model selection, instructions, Skills, policies, MCP servers, plugins, secrets, tool grants, approvals, or executor references. A node does not acquire authority from its ID, label, link, or position. Conchbase remains the execution authority. `schemaVersion: 1` of the public configuration document is unchanged; a future public composition section requires a new ADR and a new configuration schema version.

Do not import `ToolCapabilityKernel` into the validator, wire the validator into `TaskService`, persist composition documents, expose them through `docs/openapi.yaml`, or add a Pagurus form. The HTTP task path stays single-turn and continues to reject model-requested tools.

### 4. Sequencing direction

Composition execution identity comes before public tool execution. The next public contract slice must define how this internal identity becomes a versioned public configuration section, how tasks pin that revision, how node-level events and cancellation propagate, and how deterministic single-node and distinct multi-node fixtures terminate. It must run without real tool execution.

The public tool contract slice follows. Before any real tool executes in a multi-node composition, approval records, idempotency keys, and audit events must include the composition node and the pinned configuration revision in addition to task, attempt, tool name, and argument digest. A Skill never grants tools. Real executor isolation and crash-safe side effects stay separate decisions.

### 5. Current client boundary

Document the current CLI as a short-lived private database owner under ADR 0011. Pagurus and other external clients use the Runtime API. Do not claim that CLI task-state and configuration reads already use the Runtime API. Replacing those reads with an authoritative client API remains a later bounded slice after parity and authentication direction are accepted.

## Options

### A. Public tool contract first

Consequences: tool approvals, audit rows, and API envelopes can be built quickly around the current flat task identity, but multi-node execution later needs a node scope and pinned composition revision. Adding that scope to public approval and audit contracts after release would be a breaking change. Rejected because it settles the most security-sensitive public identity too early.

### B. Full composition execution and public schema now

Consequences: delivers a visible demo, but requires unresolved scheduling, concurrency, delegation, cancellation propagation, event identity, configuration versioning, and client UX decisions in one slice. Weaker models could hardcode the illustrative three-layer example. Rejected because ADR 0005 keeps those contracts open.

### C. Internal topology-neutral identity kernel first (recommended)

Consequences: gives future models a deterministic, executable boundary for arbitrary node shapes and a stable identity to scope later approvals and events. It adds one focused module and tests without any public contract change. It deliberately leaves execution semantics open, so a separate ADR is still required before the runtime runs a composition.

## Consequences

`docs/AI_TASK_QUEUE.md` moves the composition execution and public schema slice ahead of the public tool contract slice. ADR 0005 remains a proposal for the public composition contract and records that its internal identity direction is accepted here. ADR 0013 remains an internal kernel; its current approval record shape is explicitly insufficient for multi-node tool execution. ADR 0014's `schemaVersion: 1` configuration document is unchanged.

The local Runtime API remains `0.4.0`, loopback-only, and without a composition route or capability flag. CLI task-state and configuration reads keep their direct private database ownership. Repository guardrails gain an accepted ADR 0015 status check and an executable boundary that keeps composition identity separate from HTTP, tools, and hardcoded topology names.

## Validation

- Pure validator tests cover a single node, a chain, a fan-out/fan-in graph, and a graph with multiple entry nodes. Fixtures use arbitrary node IDs and labels; no test asserts a canonical layer count, role name, hierarchy, or coordination pattern.
- Tests cover canonicalization, stable content-addressed IDs, duplicate IDs, duplicate links, unknown endpoints, unknown fields, missing metadata, credential-like values, wrong entry sets, disconnected components, and cycles.
- Repository guardrails check ADR 0015 status, handoff and queue sequencing, the unchanged OpenAPI path set and version, and the absence of HTTP, tool-kernel, or hardcoded topology names in the internal validator.
- Run `npm run check`, `npm test`, and `npm run build`; CI uses no credentials, user data, public network calls, real models, or real tools.
