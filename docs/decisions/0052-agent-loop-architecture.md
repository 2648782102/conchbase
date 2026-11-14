# Decision 0052: Agent loop and capability architecture

Status: **accepted architecture direction; implementation proceeds in dependent slices**

Date: 2026-11-14 (Asia/Shanghai).

## Context

Conchbase owns a durable execution substrate: Agent identity and immutable revisions, task state and bindings, ordered events, cancellation, restart recognition, the Organization Runtime, and a publish-only tool request ledger. Every accepted slice so far executes **one model turn**. `TaskService.executeSingleTurn` calls `streamTurn` once and completes the task; a provider tool call becomes a transient observation that fails visibly instead of executing.

The user-visible consequence is that the Boss Agent can converse and propose organization actions, but no Agent can act: it cannot read a file, query a service, or use an MCP tool and then continue reasoning with the result. Without that loop, MCP, Skills, and plugins have nothing to plug into. ADR 0042/0043/0044 accepted the authority path for controlled execution but deliberately kept the executor fake or closed and never connected it to a model turn.

This decision fixes the missing middle: a bounded, durable, auditable Agent loop, and a capability-provider seam that MCP/Skill/plugin adapters can implement later.

## Decision

### 1. The loop is Runtime-owned and bounded

An Agent turn becomes a sequence of loop iterations: model turn -> zero or more tool requests -> policy/approval decision -> tool result -> next model turn, until a final answer, a turn limit, cancellation, or an unrecoverable failure. The loop runs inside `TaskService`, not in a client and not in a provider adapter.

Hard bounds are part of the contract, not tuning knobs exposed to a model: maximum iterations, maximum tool calls per iteration, maximum accumulated context bytes, and a wall-clock deadline. Exceeding any bound fails the task with a bounded error. The model cannot extend its own budget.

### 2. Tool calls are data, never authority

A model emits a proposal: tool name, bounded JSON-scalar arguments, and an optional provider call id. The proposal is untrusted. Runtime decides whether the tool exists, whether the pinned Agent revision and runtime policy allow it, whether approval is required, and whether the arguments fit the tool's declared schema. Nothing in prompt text, Agent instructions, Skill instructions, or tool output can grant a capability.

### 3. Capabilities come from providers behind one seam

A **capability provider** registers bounded tool definitions with: stable id, version, description, input description, declared side-effect class (`read` | `write` | `external`), and a fixed executor. Providers are replaceable and never own task state, policy, approval, or events.

The initial provider is Runtime-built-in read-only tools. MCP servers, Skill directories, and plugins become additional providers under their own accepted ADRs; they must reuse this seam instead of adding a parallel execution path. A Skill supplies instructions only and grants nothing.

### 4. Approval is an explicit Runtime state

A tool declared `approval_required` moves the task to `waiting_approval` and emits a durable approval request. Approval must be an explicit Runtime decision tied to task, attempt, Agent revision, configuration revision, tool id/version, and arguments digest. There is no implicit approval from UI prose, prior approvals of a different call, or a model statement. `waiting_approval` already exists in the task state machine; the loop reuses it rather than adding a second waiting model.

### 5. Every iteration is durable and replayable as facts

Each loop iteration writes bounded events in the existing global event log: model turn started/completed, tool proposed, approval requested/decided, tool started, tool succeeded/failed, and the resulting task transition. Events carry opaque ids, tool id/version, state strings, digests, and bounded scalars — never raw secrets, private paths, or whole provider envelopes.

On restart, an in-flight iteration is recognized as lost, not resumed: the task becomes `interrupted` with its history intact, matching existing restart semantics. There is no hidden replay of side effects.

### 6. Side-effect classes determine the first implementation

- `read`: may run inside the loop once policy allows; still bounded, still audited.
- `write`: requires approval and an idempotency key; must be safe to retry or must fail closed.
- `external`: deferred. Network writes, third-party mutations, and anything not idempotent require their own accepted ADR.

### 7. Provider adapters must support multi-turn context

The current adapter interface hard-codes `turnIndex === 0` and a single prompt string. The loop needs a bounded, structured conversation: prior assistant tool-call messages and tool-result messages, not a flattened prompt. Provider adapters implement this behind the same replaceable boundary; no provider shape becomes a public schema.

### 8. Client surfaces stay thin

Clients see task state, bounded events, pending approvals, and tool outcomes through the versioned Runtime API. A client never executes a tool, resolves secrets, or infers approval. Agent Chat surfaces should reuse this state model so "calling a tool" and "waiting for approval" are visible instead of collapsing into `thinking`.

### 9. Public contract changes are additive and versioned

The existing `1.0.0` 47 paths and accepted additive contract sets remain frozen. New approval/decision and loop-inspection endpoints require a new additive version, an OpenAPI update, and paired client ADRs. Internal loop mechanics may ship behind existing task routes without inventing parallel state.

## Options

### A. Keep one turn and let each client orchestrate tools

Consequences: every client becomes an execution authority, approval and audit fragment, and restart semantics diverge. Rejected.

### B. Let the provider adapter own the loop

Consequences: policy, approval, and durable events move behind provider-specific code; swapping providers changes security behavior. Rejected.

### C. Runtime-owned bounded loop with a provider seam

Consequences: one place owns authority, audit, bounds, and recovery; MCP/Skill/plugin reuse it. Accepted.

## Consequences

Agent tasks gain the ability to act and continue reasoning, with explicit bounds and approvals. The first shipped provider should be read-only built-ins so the loop can be validated end to end before any write, MCP, Skill, or plugin surface is enabled. MCP/Skill/plugin lifecycle, external writes, arbitrary host commands, and stable cross-process secrets remain blocked until their own ADRs are accepted.
