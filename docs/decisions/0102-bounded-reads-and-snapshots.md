# Decision 0102: Bounded reads and bounded in-memory snapshots

Status: **accepted and implemented**

Date: 2026-11-17 (Asia/Shanghai).

## Context

Four read paths did work proportional to the size of the store rather than to
the size of the answer. None of them was wrong on a fresh database, and all of
them degraded with use:

1. **Conversation reads.** `AgentChatService` resolved activity per message by
   reading that task's entire event log. `output_delta` dominates that log — one
   event per streamed chunk — so a long reply made every read slower, and the
   streaming route calls it every 300 ms per connected client. Worse, the read
   entry point computed a projection that all four callers discarded, and `view`
   then resolved activity a second time for the same messages.
2. **Stream replay.** The SSE route read every event after the client cursor and
   filtered it in JavaScript. A cursor from an old session meant scanning the
   whole backlog to find one conversation's events.
3. **Directory listing.** `workspace_list` read every entry of a directory to
   return at most 200, because `readdirSync` cannot stop early.
4. **Execution snapshots.** Both execution services kept an in-memory
   append-only log and copied the whole array on every append. Nothing ever
   pruned it, so a long-lived process grew one entry per transition and paid a
   growing copy per write.

The shared shape is "unbounded work for a bounded answer". Each is a latent
availability problem rather than a visible bug: nothing fails, everything just
gets slower until it matters.

## Decision

1. **Activity is folded once, from a batch.** One query returns the
   `agent_loop.*` events of every task in a conversation (`GLOB`, not `LIKE`,
   because `_` is a wildcard and the type prefix contains one). The fold became a
   pure function of those events, cached against the id of the last one — the log
   is append-only, so that id versions the whole sequence. Top-level
   `output_delta` events are never read, because activity never used them.
2. **The read entry point settles and returns; it no longer projects.** Its
   discarded projection was two event reads per message for an answer no caller
   rendered. It is now `settleBeforeRead`, named for what it does.
3. **Stream reads are windowed.** One pass scans at most `STREAM_SCAN_LIMIT`
   events. When the window fills, the client receives a fresh snapshot carrying
   the full conversation state and a cursor at the window edge, then resumes from
   there. A stale cursor costs one snapshot, never an unbounded scan, and the
   loop converges because every pass advances by the window.
4. **Directory listing iterates.** `opendirSync` reads until `offset + limit`
   entries plus one, so listing a million-entry directory costs the same as
   listing fifty.
5. **Snapshots are bounded and resequence safely.** Event and record logs keep
   the newest N entries. `sequence` is now derived from the last event rather
   than the array length: once a log is trimmed, length stops being a counter,
   and reusing it would mint duplicate sequence numbers and duplicate ids.
   Unfinished execution runs are never pruned.

## Consequences

- A cursor that points into a pruned range fails explicitly
  (`Unknown execution run event cursor`) instead of returning a wrong record.
  This is the same error code the services already used for an unknown cursor.
- `agent_loop.*` filtering is a residual predicate on top of the
  `(task_id, sequence)` index. The activity query therefore touches one task's
  loop events, not its output deltas, which is the part that grew.
- Retention bounds are process constants (`MAX_SNAPSHOT_EVENTS = 1000`). They are
  not configuration: an operator-facing knob would imply durability guarantees
  that an in-memory service does not make.
- The streaming contract gains one behaviour: a client more than one window
  behind is re-snapshotted. It does not lose state, because the snapshot carries
  the conversation, not the delta.

## Options considered

### A. Keep the unbounded reads and document a size limit

Consequences: pushes an availability cliff onto the operator, and the failure
mode is latency, not an error anyone can act on. Rejected.

### B. Move the event log behind a paging-only query layer

Consequences: correct, and larger than the problem. These paths needed a bound,
not a new storage engine; `listEvents` already accepted a `LIMIT`. Rejected for
now, and compatible with a later move.

### C. Bound the in-memory snapshot by time instead of count

Consequences: retention would depend on wall-clock scheduling, which makes tests
time-dependent and behaviour unpredictable under load. A count is deterministic.
Rejected.
