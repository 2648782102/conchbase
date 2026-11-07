# Decision 0003: Event ordering and replay (proposal)

Status: **proposed, not accepted as a public contract**

## Context

`docs/ARCHITECTURE.md` requires runtime events to have stable IDs and task IDs so clients can resume after reconnection. SSE details, the event envelope, and replay/cursor semantics remain open in `docs/AI_HANDOFF.md`.

The internal `src/runtime/event-log.ts` currently models one in-memory append-only log with a monotonic `sequence`, an ID derived from that sequence, a task ID, event type, resulting task state, and pinned configuration revision ID. `replayEvents(log, cursor)` returns events strictly after a known event ID and rejects unknown cursors.

## Options

### A. Per-runtime monotonic log, cursor by event ID (recommended)

- One authoritative append order per runtime instance.
- IDs are stable and derived from sequence for deterministic tests.
- A cursor is the last processed event ID; reconnect asks for events after it.
- Unknown cursors are errors, not silent full replay.

Consequences: simple correctness boundary and deduplication by ID. Requires a durable transaction and an authoritative writer before restart/replay can be claimed. Multiple runtime processes and clock-based ordering remain out of scope.

### B. Per-task sequences

- Each task has its own sequence and clients maintain one cursor per task.

Consequences: easier task-local rendering, but a global SSE stream needs a second ordering key or can violate cross-task causality. Rejected for the first public contract.

### C. Timestamps as cursors

- Clients resume from the last observed timestamp.

Consequences: clock skew, equal timestamps, and out-of-order writes make loss or duplication easy. Rejected.

## Recommendation

Use option A as an internal invariant and test target. Before exposing SSE or task routes, obtain product direction on the wire envelope, `Last-Event-ID` mapping, durable store transactions, retention, error codes, and multi-process ownership. Do not describe replay as production-ready until those are implemented.

## Validation

`tests/event-log.test.ts` asserts monotonic sequences, stable IDs, replay from a cursor without duplicates, full replay from a null cursor, and rejection of unknown cursors.
