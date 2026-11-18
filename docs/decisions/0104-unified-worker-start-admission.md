# Decision 0104: Unified worker-start admission through the global scheduler

Status: **accepted and implemented**

Date: 2026-11-19 (Asia/Shanghai).

## Context

ADRs 0100–0102 define a non-preemptive global work scheduler with capacity (`globalActive`, `perProjectActive`), priority, fairness, and visible hold decisions, and inject it into `OrganizationCoordinator`. ADR 0103 proves loop-iteration checkpoint/resume on restart.

A review of the live execution path found a gap between those decisions and how workers actually start:

- `BossModeService.submit` applies model-authored `start_worker` (and `create_agent`, which starts its worker) through `ensureWorkItem`, which directly calls `platform.startWork(workItemId, 'open')` and `taskService.startTask(taskId)`. This path **does not consult the scheduler**.
- `OrganizationCoordinator.reconcile()` (which owns scheduler admission) runs at the **end** of a Boss turn, after that turn's workers have been awaited to a terminal state. Its `startWork` decisions therefore do not govern the turn's primary dispatches.
- `runtime-config` already exposes operator settings `CONCHBASE_GLOBAL_ACTIVE_WORK` (default 8) and `CONCHBASE_PER_PROJECT_ACTIVE_WORK` (default 2). Today these are **published by the HTTP runtime-status route but consumed by no execution path**; `BossModeService` constructs its coordinator without scheduler limits, so both the coordinator and the real dispatch fall back to policy defaults, and the real dispatch is not admitted at all.

Consequence: concurrent Boss submissions (agent-chat calls `bossMode.submit` fire-and-forget, so turns overlap) can start more workers than the configured global or per-project capacity, and the operator's scheduler settings do not constrain them. Before any yield/preemption (the deferred part of ADR 0100) is meaningful, **every worker start must pass one admission decision**.

## Decision

1. **One admission point.** `ensureWorkItem` is the single place a worker's `WorkItem` transitions `open → running` and its task starts. Before that transition, it asks the global scheduler whether this start is admitted. No other path starts a worker task.
2. **Admission uses the existing pure scheduler.** Build the `SchedulableWork` view from the current platform work state (running/open/paused, each with project id, priority from open attention requests, and enqueue order) plus the one pending start. Call `scheduleGlobalWork(work, limits)`. Start only when the pending work item receives a `start` decision; otherwise record a `hold` with the scheduler's reason and leave the work item `open`.
3. **Operator limits are wired through.** `BossModeServiceOptions` gains `schedulerLimits?: SchedulerLimits`. Both construction sites (HTTP `create-app` and CLI) pass `{ globalActive: config.globalActiveWork, perProjectActive: config.perProjectActiveWork }`. When absent, the scheduler's existing defaults apply (backward compatible for fixtures and library callers).
4. **Held work stays visible and retryable.** A held `start_worker` produces a `skipped` execution with a bounded detail naming the hold reason, and contributes a hold record to the turn result using the existing `BossModeSubmitResult.holds` shape (`workItemId`, `projectId`, `reason`). The worker remains `authorized` and its work item `open`; a later Boss turn (or a coordinator reconcile at a later turn boundary) can admit it when capacity frees. No new work state, organization action, or public route is introduced.
   The organization `start_worker` action is applied **only after** admission succeeds. Previously it was applied first and a skipped start stranded a `running` worker with no task (handled by a compensating `report_worker`). With admission before the state transition, a held worker stays `authorized`/`idle`; that compensating path is removed.
5. **Automatic re-admission.** When `waitForTasks` is enabled (the HTTP and CLI default), capacity released by a turn's admitted workers lets held workers start within the same bounded submit: after awaiting the turn's outcomes, the Runtime repeatedly re-admits authorized workers whose work item is `open` and whose task is `queued`, awaiting each admitted batch, until no further worker can start. A hold is therefore a queue position, not a dropped request. With `waitForTasks` disabled, currently-admitted held workers are started once without awaiting; a later submit drains further capacity. Round count is bounded by the number of known worker executions.
6. **Priority and fairness are unchanged.** Admission reuses `scheduleGlobalWork` exactly: interactive (open attention) before normal, then per-project fairness, then enqueue sequence. This ADR adds no preemption: a running worker is never stopped, and a held worker is never failed.
7. **Single writer and single owner preserved.** The scheduler stays pure. `BossModeService` remains the only component that pairs `platform.startWork` with `taskService.startTask`; no second executor or queue is created.

## Options

### A. Admit inside `OrganizationCoordinator` only

Consequences: leaves the primary `ensureWorkItem` path unadmits, so the gap remains. Rejected.

### B. Add a separate admission service / queue table

Consequences: a second owner of work truth next to the `open` WorkItem durable queue (ADR 0101) and a second lifecycle to reconcile. Rejected.

### C. Ask the existing pure scheduler at the one real start point and wire operator limits

Consequences: one admission decision, reuses capacity/priority/fairness and the existing hold shape, no new state or contract. Accepted.

## Validation

- Fixtures cover: a start admitted under capacity; a start held at `globalActive`; a start held at `perProjectActive`; interactive work admitted ahead of normal work; fairness across projects; operator limits overriding defaults; a held worker re-admitted on a later turn after capacity frees; and no worker task started while held.
- A fixture drives three same-project workers with `perProjectActive: 1` and asserts all three eventually succeed through bounded re-admission while no worker remains stranded.
- Existing boss-mode, organization, scheduler, and paired-runtime fixtures remain green because no public API, event, or schema changes.
- `npm run check`, `npm test`, and `npm run build` pass.

## Consequences

The `globalActiveWork` / `perProjectActiveWork` operator settings now actually bound concurrent worker execution, and every worker start — whether from `start_worker` or `create_agent` — passes the same capacity/priority/fairness decision. Held work is explicit and retryable rather than silently over-capacity. Yield/preemption (a running worker voluntarily releasing its slot) remains a later ADR; this decision establishes the admission authority it would build on.
