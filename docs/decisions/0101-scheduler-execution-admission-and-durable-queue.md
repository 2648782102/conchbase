# Decision 0101: Scheduler execution admission and durable queue

Status: **accepted and implemented**

Date: 2026-11-17 (Asia/Shanghai).

## Context

ADR 0100 added a pure non-preemptive scheduler with capacity, priority, fairness, and visible hold decisions, but did not connect it to execution. ADR 0099 made worker outcomes within one Boss turn concurrent. The missing piece is a place where work waits durably and an execution point where the scheduler admits it.

The Repository already has the needed substrate:

- `WorkItem` has durable `open | running | paused | completed | cancelled` state.
- `SqlitePlatformStore` owns `startWork`, `stopWork`, `completeWork`, and assignment recovery in the same single SQLite owner.
- `OrganizationCoordinator` already turns organization facts into `start_work` / `stop_work` / `complete_work` commands through injected controls.

Creating another queue table or scheduler service would break the single owner rule. The queue is the set of durable `open` WorkItems.

## Decision

1. **Durable queue = `open` WorkItems.** No new queue table. A WorkItem's enqueue order is the sequence of its `work.queued` event; where that is unavailable, its id provides a stable tie-break.
2. **Admission replaces raw start.** Before `start_work` reaches the platform control, the coordinator asks the scheduler which queued WorkItems may start. Only `start` decisions are dispatched; `hold` decisions stay `open` and are emitted as `organization.work_held` with a bounded reason.
3. **Boss is the scheduling source for user work.** WorkItems created by Boss hiring are classified `interactive` when they come from an Attention answer or an explicit user message, otherwise `normal`. Classification is data on the Work event, not a model-supplied role.
4. **Action application remains serial and non-preemptive.** The scheduler only decides admission at reconcile points; running tasks are never stopped for capacity.
5. **Capacity is operator configuration.** ADR 0100's `CONCHBASE_GLOBAL_ACTIVE_WORK` and `CONCHBASE_PER_PROJECT_ACTIVE_WORK` feed the coordinator; no client or Agent can override them.
6. **Held work is visible.** A held WorkItem remains `open` (the durable queue) and the coordinator result carries the hold decision with `{ workItemId, reason }`. No new organization action is introduced just to log a hold; that would widen the public action vocabulary for a scheduling detail. Clients that need durability can derive held state from the WorkItem plus current capacity, and the Runtime may expose a dedicated read model in a later ADR if needed.
7. **No public contract change.** This uses existing organization state and coordinator results; no endpoint, schema, action, or path count changes.

## Options

### A. Build a new durable scheduler queue table

Consequences: a second source of work truth and a second lifecycle to reconcile. Rejected.

### B. Admit directly in TaskService

Consequences: couples execution loop to organization priority and project fairness, and bypasses the coordinator seam. Rejected.

### C. Inject the global scheduler into OrganizationCoordinator

Consequences: reuses the single owner, the existing work state machine, and the existing command vocabulary. Accepted.

## Validation

- Fixtures cover: open WorkItems queued by event order, capacity admission, hold decisions with reasons, priority for interactive work, fairness across projects, no preemption of running work, and no duplicate start commands.
- Existing organization and paired-runtime fixtures must remain green because no public contract changes.

## Consequences

Work now waits durably as `open` WorkItems and is admitted by one policy at reconcile points. Boss turns can still finish while workers overlap, but global capacity is respected across turns. Time-slice preemption remains out of scope until checkpoint/resume is accepted.
