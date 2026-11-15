# Decision 0071: Reuse identical read-tool results within one task attempt

Status: **accepted and implemented identical-read reuse**

Date: 2026-11-15 (Asia/Shanghai).

## Context

A live Agent Chat session asked an Agent to list a directory and read a file. The transcript shows the model calling `workspace_list` twice with identical arguments, then `workspace_read` twice with identical arguments, and then running out of the six-iteration budget:

```
iteration 2  workspace_list  arg_c4311b4a  -> executed (843 bytes)
iteration 2  workspace_read  arg_01e7c009  -> executed (200 bytes)
iteration 3  workspace_list  arg_f7e7699c  -> executed (843 bytes, identical result)
iteration 3  workspace_read  arg_19413411  -> failed not_found
iteration 4  workspace_read  arg_01e7c009  -> executed (200 bytes, identical result)
```

Two of five loop iterations were spent re-executing calls whose result the Runtime had already produced and already placed in the conversation. The model did not learn anything from the repeat; it received the same bytes again. The budget, not the task, ended the run.

`writeAlreadyApplied` already prevents an identical **write** from executing twice. There was no equivalent for reads, so the cheap case was handled and the common case was not.

## Decision

1. Within one task attempt, an identical read call is served from the result already recorded for this task rather than executed again. Identity is `(toolId, version, canonical arguments digest)` — the same digest already written to `agent_loop.tool_executed`.
2. The model still receives the full result content, so its conversation is unchanged. Only the redundant execution and its cost are removed.
3. The repeat is recorded as a durable event, `agent_loop.tool_reused`, carrying the iteration, tool id, arguments digest, and the original result digest. A reused call is visible in the audit trail, not silently swallowed.
4. Reuse applies to `read` tools only. `write` and `external` keep their existing approval and idempotency behaviour; a read result can be safely replayed because it has no side effect.
5. Reuse is scoped to one attempt. A retry starts with no cached results, because the world may have changed between attempts.
6. The lookup is bounded: it scans the task's own events once per tool call and does not add a new table, index, or cache with its own lifetime. A task has a small bounded event count, and correctness matters more than shaving a scan at this size.
7. The model's tool-result message for a reused call is prefixed with a short note so it can tell the difference between fresh and reused data. This matters when a model repeats a call expecting a change.

## Options

### A. Let the model repeat reads freely

Consequences: identical work burns the iteration budget and the transcript fills with duplicate executions. This is the observed defect. Rejected.

### B. Cache read results across tasks

Consequences: a file change between tasks would serve stale data with no indication, and invalidation would need filesystem watching or mtime tracking. Too much machinery for the problem. Rejected.

### C. Reuse within one attempt, with a durable reuse event

Consequences: identical reads cost one execution, the audit trail shows the reuse, and a retry still sees fresh data. Accepted.

## Validation

- `tests/read-reuse.test.ts` asserts an identical read executes once, the second call returns the same content with a reuse note, an `agent_loop.tool_reused` event is recorded, a different argument set still executes, and a new attempt does not reuse a previous attempt's result.
- The existing write-idempotency tests continue to pass unchanged, proving read reuse did not alter write behaviour.
- `npm run check`, `npm test`, and `npm run build` pass.

## Consequences

A model that repeats a read wastes one turn instead of two executions, and the iteration budget survives longer for real work. The trade-off is one extra event per reuse and a small scan; both are bounded and visible.

This does not make a looping model productive: a model that repeats a call forever still exhausts its budget. It makes a single redundant repeat cheap, which is the observed and common case.
