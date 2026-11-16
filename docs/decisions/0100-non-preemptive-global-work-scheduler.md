# Decision 0100: Non-preemptive global work scheduler

Status: **accepted and implemented**

Date: 2026-11-17 (Asia/Shanghai).

## Context

ADR 0099 made worker outcomes within one Boss turn concurrent. That solves one turn, not the whole system: multiple Boss turns and multiple projects can still create more live work than the Runtime should run at once.

Operating systems offer a useful vocabulary — run queues, priorities, fairness, time slices, preemption — but the analogy has a hard limit. An Agent loop contains model calls, tools, approvals, and external side effects. Unlike a CPU process, it cannot be transparently suspended and resumed at an arbitrary instruction. Current `cancelTask` / `stopWork` / `recoverAssignments` are interruption-and-retry mechanisms, not checkpoint-continue.

## Decision

1. **Introduce a global scheduler as a pure policy function, not a service.** It takes a snapshot of runnable work plus capacity limits and returns `start` and `hold` decisions. It owns no database, no TaskService, and no lifecycle.
2. **Non-preemptive.** Running tasks are never stopped to make room. Scheduling happens only when work is submitted, finishes, is cancelled, or an approval/attention decision changes capacity.
3. **Bounded capacity.** Global active tasks and per-project active tasks are explicit, validated limits. Defaults follow the existing organization planner: 8 global and 2 per project.
4. **Priority order.** User messages and Attention answers preempt *waiting* work, not running work. After that, queued work is ordered by `(project fairness score, enqueue sequence)`: a project that recently consumed a slot yields to one that has not.
5. **Visible holds.** A held work item is not silently dropped. The decision records `heldBy: 'global-limit' | 'project-limit'` so clients and relays can explain why nothing launched.
6. **No new public contract.** This is an internal scheduling policy over existing work state. The additive API stays unchanged.
7. **Time slices are deferred.** A future ADR may add loop-iteration or deadline-based yielding only after checkpoint/resume is proven at loop boundaries. This ADR explicitly rejects preemption now.

## Options

### A. CPU-style round robin with preemption

Consequences: requires transparent checkpoint/resume across model calls, tool execution, and approvals. Current Runtime provides retry from the beginning, not continuation. Rejected.

### B. First-come, first-served with no fairness

Consequences: one busy project can monopolize slots. Rejected.

### C. Pure non-preemptive fair scheduler

Consequences: bounded concurrency, priority for interactive work, fairness across projects, and no new state owner. Accepted.

## Validation

- Deterministic fixtures cover global and per-project caps, priority over waiting work, fairness across projects, visible hold reasons, stability by enqueue sequence, and that running tasks are never preempted.

## Consequences

This establishes the policy layer for global scheduling without pretending the Runtime can preempt Agent loops. When checkpoint/resume matures, preemption can be added behind the same decision interface.
