# Decision 0089: Distinguish `done` from `replied` in Agent Chat

Status: **accepted and implemented**

Date: 2026-11-16 (Asia/Shanghai).

## Context

Agent Chat had one terminal success state, `replied`. That collapsed two different situations into one: "the agent finished and you have not looked at it" and "the agent finished and you already read it". A task list cannot act on that — every completed conversation looks equally urgent, so none of them do.

The `herdr` project models this directly with `done` versus `idle`. The distinction is worth copying because it is the cheapest possible signal for "what needs me now".

## Decision

1. **`done` means finished and unread.** A successful completion produces `done`, not `replied`.
2. **Reading the conversation promotes it.** `view()` marks read: each `done` assistant message becomes `replied`, and `lastReadAt` is persisted on the conversation.
3. **The marker is durable.** `last_read_at` is a column, not an in-process flag, so a restart does not resurrect old "unread" work.
4. **A finished reply that predates this feature stays unread.** `last_read_at` defaults to null rather than to creation time; claiming the user saw something they did not is worse than one extra unread marker.
5. **The conversation list exposes it.** `AgentChatConversationSummary` gains `unread` and `lastState`, so a client can sort or badge without opening each conversation.
6. **`replied` remains valid.** It is not removed: old records and freshly-read conversations still carry it, and both states are terminal success for every consumer that only cares whether the agent finished.

## Options

### A. Keep one success state and sort by timestamp

Consequences: cheapest, but "finished two hours ago, unread" and "read an hour ago" are indistinguishable, which is exactly the case a task list exists to resolve. Rejected.

### B. Track unread per client

Consequences: each client would invent its own notion of "seen", they would disagree, and the Runtime could never answer "what needs attention" uniformly. Rejected.

### C. `done` on completion, promoted on read, persisted

Consequences: one durable source of truth that any client can consume; costs one column and one write on first read. Accepted.

## Validation

- `tests/agent-done-idle.test.ts`: a reply is `done` in storage before any view; viewing promotes it to `replied` and records `lastReadAt`; the list summary reports `unread: false` and `lastState: replied` after a read.
- Existing Agent Chat, stream, and tool-projection suites were re-run unchanged and pass, because reading-then-asserting still yields `replied`.

## Correction recorded

The first implementation broke seven existing tests with "回复已取消". The cause was mine: `refreshConversation` chose the success body with `state === 'replied'`, so once success became `done` every completion fell through to the cancelled branch. The fix checks both states. This is worth remembering: introducing a new terminal state means auditing every equality check against the old one, not just the state machine.

## Consequences

A task list can now surface finished-but-unread work directly from the list endpoint. The contract grows one enum value and two list fields; nothing is removed. Clients that only distinguish "finished" from "running" keep working unchanged.
