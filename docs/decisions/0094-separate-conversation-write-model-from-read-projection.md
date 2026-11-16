# Decision 0094: Separate the conversation write model from the read projection

Status: **accepted and implemented**

Date: 2026-11-16 (Asia/Shanghai).

## Context

`AgentChatService` both owned conversation state and projected task state onto it. The projection ran inside `view()`, which meant **every read wrote to storage**: a polling client silently mutated the record it was reading, and three parties (Boss, task lifecycle, chat service) could each write the same conversation.

That is the ambiguity an external review flagged as "session projection should not be the only source of truth". The criticism was correct: there was one implementation that both computed and persisted, so "what the user sees" and "what is stored" could never be reasoned about separately.

## Decision

1. **One pure projection, two callers.** `agent-chat-projection.ts` exports `projectMessage`, which returns the projected message or `null` when nothing changed. `null` is load-bearing: it lets both callers skip work.
2. **The read path does not compute a projection for display and store it.** `projectForRead` maps messages through `projectMessage` and returns them; it never calls `persist`.
3. **Settling is explicit and bounded.** `settleRecord` applies the projection and persists, and is called from the paths that already intend to mutate (message send, approval, read-settling). It is synchronous, so a read that races a just-finished task still sees the settled state rather than a stale one.
4. **No per-service task subscription.** The first attempt subscribed to `TaskService.onChange` in the constructor; that leaked a listener per instance and made shutdown observable (`changeListenerCount` never returned to zero). The lazy settle path already runs on every read and stream tick, so the subscription was both a leak and redundant. It was removed.
5. **Dead code is removed, not kept.** An intermediate implementation left an unused `unusedWriteProjection`; it is gone.

## Options

### A. Keep projecting inside the read path

Consequences: every poll is a write; concurrent readers race on the same record; there is no way to say whether the database or the computation is authoritative. Rejected.

### B. Subscribe to task changes and persist eagerly

Consequences: correct in principle, but a per-instance subscription requires lifecycle management the service does not have, and the first attempt leaked listeners. Rejected in favour of the bounded lazy settle.

### C. Pure projection plus an explicit settle step

Consequences: reads stay read-only, writes happen only where a mutation was already intended, and the rules live in one testable function. Accepted.

## Validation

- `tests/agent-chat-projection.test.ts`: 10 assertions covering streaming progress, the `null` no-change contract, done/failed/cancelled/unavailable outcomes, operator rejection wording, missing tasks, and that terminal or non-assistant messages are never re-projected.
- The full suite (506) passes. Two real regressions were found and fixed during the work: a hard dependency on `onChange` broke minimal store fixtures, and a per-instance subscription leaked a listener.

## Consequences

- `agent-chat.ts`: 1021 → 997 lines.
- A read can no longer mutate durable state; the projection is directly testable in isolation.
- The remaining `persist` calls are all on explicit mutation paths, not on display.
