# Decision 0103: --help

Status: **draft; not accepted**

Date: 2026-11-18 (Asia/Shanghai).
# Decision 0103: Loop-iteration checkpoint and resume on restart

Status: **accepted and implemented**

Date: 2026-11-19 (Asia/Shanghai).

## Context

ADR 0100 defines a non-preemptive global work scheduler and explicitly defers time slices: "a future ADR may add loop-iteration or deadline-based yielding only after checkpoint/resume is proven at loop boundaries." ADR 0101 makes the durable queue the set of `open` WorkItems and admits `start_work` at reconcile points; ADR 0102 publishes hold reasons. Across those decisions, a running Agent loop that loses its process is still **interrupted and retried from iteration 0**: `TaskService.interruptIncompleteTasks()` marks every non-terminal task (except `waiting_approval`) `interrupted`, and `executeAgentLoop` always rebuilds the initial message list and calls `runAgentLoop(task, messages, 0, ...)`.

The Runtime already has the substrate for continuation:

- `agent_loop_state` persists one opaque state string per task via `saveLoopState` / `getLoopState`.
- The approval checkpoint (ADR 0057/0058) stores `{ iteration, messages, pending }` there and, after an operator decision, resumes through `runAgentLoop(task, messages, checkpoint.iteration + 1, ...)`. This proves `ProviderMessage[]` is JSON-serializable and that the loop can resume from a nonzero iteration.
- `runAgentLoop(task, messages, startIteration, ...)` already accepts both a resumed message list and a start iteration.

The missing fact is a checkpoint at **normal iteration boundaries**, so a restart can continue from the last safe point instead of discarding completed work. This ADR adds exactly that proof. It does not add preemption, time slices, or a new public contract.

## Decision

1. **Checkpoint at a safe point.** After a model turn's tool calls are fully drained (`drainToolCalls` returns `'drained'`), and before the next iteration starts, `runAgentLoop` persists `{ iteration, messages }` to `agent_loop_state`. A checkpoint is written only when all side effects of the completed iteration are already durable; no checkpoint is written inside a model request or a tool invocation.
2. **Checkpoint shape.** The state is the JSON object `{ version: 1, iteration: number, messages: ProviderMessage[] }`. `version` distinguishes it from the legacy approval checkpoint (`{ iteration, messages, pending }`); a state without `version: 1` is not a continuation checkpoint. The approval path keeps its own shape and behavior unchanged.
3. **Clear on terminal paths.** `saveLoopState(taskId, null)` is called when a task completes, fails, is cancelled/rejected, or is retried, so a stale checkpoint can never resume a task whose iteration state no longer applies.
4. **Restart continuation.** `interruptIncompleteTasks()` distinguishes two cases for a non-terminal `running` task:
   - With a valid `version: 1` checkpoint: keep the task non-terminal and re-dispatch it through a Runtime-owned resume entry that reconstructs `messages` and `startIteration` from the checkpoint. The task keeps its pinned Agent revision, configuration revision, attempt, and model.
   - Without a valid checkpoint: keep the existing behavior and mark the task `interrupted`.
   `waiting_approval` tasks keep their existing approval-resume behavior and are not treated as continuation checkpoints.
5. **Deterministic replay.** Resumption re-invokes the model for the iteration after the checkpoint with the persisted message list. The resumed iteration may produce a different model output; that is the same tolerance already accepted for approval resume. At most one model call is re-issued relative to the last completed iteration. No tool already recorded as executed in a persisted iteration is re-executed.
6. **No contract or schema change.** No public path, organization action, event type, work-contract version, `user_version`, or OpenAPI field changes. `agent_loop_state` remains an internal private table with the same single SQLite owner. The global scheduler's decision interface is untouched; this ADR only supplies the checkpoint/resume primitive a later preemption ADR can reuse.

## Options

### A. Persist a full task snapshot at every iteration

Consequences: duplicates state the event log and task store already own, and adds a second lifecycle to reconcile. Rejected.

### B. Resume from the event log by replaying `agent_loop.*` events

Consequences: requires reconstructing model message order from events that were designed as an audit projection, and conflates observability with execution state. Rejected.

### C. Generalize the existing `agent_loop_state` checkpoint to iteration boundaries

Consequences: reuses the proven approval-resume seam, one private table, and one SQLite owner; adds one small state shape and one dispatch branch. Accepted.

## Validation

- A fixture drives a fake Magpie-compatible provider through several tool iterations, forces a restart after a persisted boundary, and asserts the resumed task re-enters the loop at `checkpoint.iteration + 1` with the persisted messages, without re-executing already-completed tool calls.
- A fixture asserts a task with no continuation checkpoint is still marked `interrupted` on restart (existing behavior preserved).
- A fixture asserts `waiting_approval` resume and the approval checkpoint shape are unchanged.
- A fixture asserts terminal/cancelled/rejected paths clear the checkpoint and that a stale checkpoint cannot resume a retried task.
- Existing agent-loop, approval, organization, and paired-runtime fixtures remain green because no public contract changes.

## Consequences

A running Agent loop that loses its process now continues from the last completed iteration instead of restarting from iteration 0. This proves checkpoint/resume at loop boundaries, the prerequisite ADR 0100 named for a future time-slice or preemption decision. Preemption itself, cross-process continuation after a crash *inside* a model call or tool invocation, and any public scheduling contract remain out of scope.
