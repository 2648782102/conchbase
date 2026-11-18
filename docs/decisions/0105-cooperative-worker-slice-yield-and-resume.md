# Decision 0105: Cooperative worker slice yield and resume

Status: **accepted and implemented**

Date: 2026-11-19 (Asia/Shanghai).

## Context

ADR 0100 defines a non-preemptive global scheduler and explicitly defers time slices: "a future ADR may add loop-iteration or deadline-based yielding only after checkpoint/resume is proven at loop boundaries." ADR 0103 proves loop-iteration checkpoint/resume; ADR 0104 makes every worker start pass scheduler capacity admission and automatically re-admits held work.

The remaining gap is a **long-running worker**: one whose Agent loop needs more iterations than a fair turn should allow. Today such a worker holds its global/per-project slot until its task reaches a terminal state (up to the operator loop deadline, default 120s). Queued work from other projects waits even though the running worker has already completed safe iteration boundaries. ADR 0100 rejects forced preemption of a running model call, but permits **cooperative** loop-iteration yielding.

The Runtime already has the required primitives:
- `agent_loop_state` stores a versioned `{ iteration, messages }` checkpoint at each completed iteration (ADR 0103), and `startTask` resumes a `running` task with that checkpoint from `iteration + 1`.
- `report_worker` accepts intermediate `progress` (worker stays `running`) and `waiting` (worker becomes `idle`) states; `nextWorkerState` maps them without any enum change.
- ADR 0104 re-admits work whose item is `open` or `paused` and binds a fresh task when the previous one is terminal.

## Decision

1. **A slice is bounded by loop iterations.** A new operator setting `CONCHBASE_WORKER_SLICE_ITERATIONS` (default `0` = disabled, preserving current behavior; integer `1..maxIterations-1` when enabled) caps how many Agent-loop iterations one worker task may run before it must yield. It is Runtime-owned; a model cannot change it.
2. **Yield at a safe boundary.** When a worker task reaches the slice cap at a completed iteration (after its tool side effects are durable and the ADR 0103 checkpoint is written), it does **not** start another model call. It records `agent_loop.turn_completed` with `kind: 'slice_yield'`, transitions the task to `interrupted` (an existing terminal state) while **keeping the checkpoint**, and stops the loop. No in-flight model call or tool is aborted; no checkpoint is written inside a model call.
3. **The slot is released.** The Boss treats a task interrupted with a continuation checkpoint as a **yield, not a failure**: it records `report_worker` with state `waiting` (worker becomes `idle`, ready to be re-admitted), and calls a new `pauseWork(workItemId, 'running')` platform primitive (`running → paused`, assignment `running → interrupted`, a `work.paused` event). The global/per-project slot is now free for queued work.
4. **Resume by re-admission.** A paused work item is queued work under the ADR 0100 scheduler. When the scheduler admits it again, the Runtime calls `startWork(workItemId, 'paused')` and `startTask(taskId)` on the **same** WorkItem and task. `startTask` accepts an `interrupted` task that holds a versioned ADR 0103 checkpoint, transitions it back to `running` with an internal `task.resumed` event, and continues at `checkpoint.iteration + 1` with the persisted messages. No rebind or checkpoint migration is needed. The same Agent revision, configuration revision, and model pin apply.
5. **Bounded and deterministic.** A worker yields at most once per `sliceIterations` iterations; total progress is still capped by the existing `maxIterations` loop budget across all slices, so a worker cannot run forever. Each yielded slice produces one `waiting` report and one `work.paused`; the final slice produces `ready`/`attention`/`failed` and `work.completed`. Re-admission order is the existing scheduler order (interactive, per-project fairness, enqueue sequence).
6. **No preemption, no new public contract.** A running worker is never stopped mid-model-call; it only declines to begin the next iteration. No route, action, event vocabulary visible on the public API, work-contract version, or schema version changes. `paused` is already a published work state; `waiting` is already a published report state. `pauseWork` is an internal platform-store primitive.

## Options

### A. Force-stop a running task when higher-priority work arrives

Consequences: aborts a model call and requires transparent suspend/resume at arbitrary instructions — exactly what ADR 0100 rejects. Rejected.

### B. Bound the whole turn by a deadline and fail over-capacity workers

Consequences: loses completed iteration work and reports a false failure. Rejected.

### C. Cooperative iteration-slice yield with in-place checkpoint resume

Consequences: releases the slot only at a safe boundary, reuses ADR 0103/0104, adds one platform primitive, one operator setting, and one internal lifecycle event. Accepted.

## Validation

- A fixture drives a worker whose scripted model produces tool calls for more than `sliceIterations` iterations and asserts: the task yields after the cap, an `agent_loop.turn_completed` with `kind: 'slice_yield'` is recorded, the checkpoint persists, `report_worker(waiting)` is recorded, and the work item becomes `paused`.
- A fixture asserts a paused work item is re-admitted by the scheduler and the worker continues from the migrated checkpoint without re-executing earlier tool calls, eventually reaching a final report and `work.completed`.
- A fixture asserts `CONCHBASE_WORKER_SLICE_ITERATIONS=0` preserves the current single-slice behavior.
- A fixture asserts an operator-configured slice value is validated (integer range) and that a model cannot override it.
- Existing agent-loop, boss-mode, organization, scheduler, and paired-runtime fixtures remain green because no public contract changes.
- `npm run check`, `npm test`, and `npm run build` pass.

## Consequences

A long-running worker now releases its scheduling slot at bounded iteration boundaries, letting queued work from other projects run, and resumes from its checkpoint when re-admitted. This is cooperative, not preemptive: a worker is never stopped inside a model call or tool. The behavior is opt-in via an operator setting and defaults to the existing unbounded-per-task behavior. Forced preemption, cross-process resume of an in-flight model call, and any public scheduling contract remain out of scope.
