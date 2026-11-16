# Decision 0099: Bounded worker concurrency design

Status: **accepted and implemented**

Date: 2026-11-17 (Asia/Shanghai).

## Context

The organization domain has already accepted concurrency limits (`globalActive`, `perProjectActive`) in `organization-execution.ts`, but the Boss bridge does not actually run workers concurrently: `submit` iterates `createdWorkers` and `collectWorkerOutcomes` awaits each task in sequence. If a plan hires two workers, the second is dispatched only after the first finishes.

This is not a correctness bug — it is why current replies are deterministic — but it prevents the product loop from matching the target: multiple workers on a project should make progress in parallel.

Two earlier suggestions are rejected here:

- A standalone "dispatch middle platform" would become a second state owner.
- Naively changing the wait loop to `Promise.all` would make organization event writes concurrent and destroy deterministic ordering.

## Decision

1. **Parallelize waiting, not state mutation.** All worker tasks dispatched in one Boss turn are started first; their outcomes are then awaited concurrently. Applying reports, attention, retirement, and relays remains serial and in the original plan order.
2. **A bounded batch is the only concurrency unit.** Concurrency exists within one accepted intent's `createdWorkers` batch. There is no global scheduler loop in this slice, and no unbounded fire-and-forget work.
3. **Deterministic outcome order.** Even when tasks finish out of order, outcomes are collected in the original dispatch order. The final Boss reply therefore stays stable and does not depend on timing.
4. **A failure in one worker does not cancel the others.** Each task is waited independently. The existing per-action failure isolation rule is preserved.
5. **Attention priority remains authoritative.** If any worker requests attention, the final state remains `waiting_attention`; concurrency does not downgrade or reorder it.
6. **Task lifetime stays owned by TaskService.** Boss waits on task snapshots; it does not create a second executor, loop, or cancellation path.
7. **No new public contract.** This changes execution timing and adds a deterministic fixture, not an endpoint or schema.

## Options

### A. Sequential wait (current)

Consequences: deterministic and safe, but workers hired in one turn cannot overlap. Rejected now that the rest of the architecture has been modularized.

### B. Parallel `Promise.all` around the whole apply loop

Consequences: concurrent `store.apply` calls and non-deterministic organization events. Rejected.

### C. Concurrent task awaiting plus serial outcome application

Consequences: workers overlap while Runtime remains the single ordered writer. Accepted.

## Validation

- A deterministic fixture starts two workers with different delays, proves both were running before either finished, and asserts the final outcome order matches dispatch order.
- Existing Boss fixtures continue to assert failure isolation, attention precedence, and reply composition.

## Consequences

Turns that hire multiple workers now complete in roughly the duration of the slowest worker rather than the sum. Event order and replies remain deterministic. A future global scheduler can reuse this seam without changing the public contract.
