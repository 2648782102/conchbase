# Decision 0080: Boss outcome replies and implicit lifecycle steps

Status: **accepted and implemented**

Date: 2026-11-15 (Asia/Shanghai).

## Context

A live Boss-mode run produced an answer that said a worker had been prepared and would report later, even though that worker finished seconds afterwards with a real result. The durable event log, by contrast, was complete and correct: project opened, project activated, worker proposed, authorized, execution recorded, worker started, report recorded.

Three defects combined to produce that mismatch:

1. **The Boss reply was generated before the work ran.** `BossModeService.submit` asks the model for a reply and a plan in one call, then executes the plan. The relay therefore describes intended or prepared work. When `collectWorkerOutcomes` later awaited the worker, nothing rewrote the reply, so the user saw the pre-execution promise instead of the result.
2. **A duplicate lifecycle step surfaced as a fake failure.** `create_agent` already authorizes and starts the worker inside `createDynamicAgent`. A plan that also lists `authorize_worker` — which is reasonable, since that is a documented action type — hit `Worker is not proposed` and was recorded as `failed`, even though the worker was running normally.
3. **A duplicate `start_worker` was silently dropped.** The guard returned without recording anything, so the execution list looked shorter than the plan and gave no explanation.

The earlier `executions.every(failed)` throw hid defect 2: one failure among several successes never surfaced.

## Decision

1. **A settled Boss turn reports real outcomes.** When at least one worker was awaited, the final reply is composed from each worker's terminal task state and output. The pre-execution model relay is retained for turns with no awaited work, where it is the only real content.
2. **Worker output is untrusted.** The composed reply passes through the same secret-like filter as model output and stays within the published reply bound. If the filter trips, the reply reports that the body was withheld rather than echoing it.
3. **Implicit lifecycle steps are idempotent skips.** `authorize_worker` on a worker that is no longer `proposed`, and `start_worker` on a worker whose latest task is still in flight, produce `skipped` with a bounded reason. Neither is an execution failure, because the Runtime already performed that transition as part of `create_agent`.
4. **One plan dispatches a worker at most once.** A worker started by `create_agent`, or by an earlier `start_worker` in the same plan, is not dispatched again later in that plan. The per-turn set is what makes this correct even when the first task finishes so quickly that it is already terminal by the next action; keying the guard only on task state would start a second run.
5. **Settled outcomes are returned even when already recorded.** A repeated submit still restates a previously recorded result instead of silently dropping it; durable reporting remains keyed by task id so no duplicate report is written.
6. **A vanished task is not an outcome.** If a task disappears while being awaited, no outcome is fabricated for it.

## Options

### A. Re-call the model after execution to summarize

Consequences: the summary is fluent, but costs a second model call per turn, adds latency, and makes the reply non-deterministic for identical work. Rejected as the default; a deterministic composition from real task output is cheaper and truthful. A model-authored summary can be layered later without changing the contract.

### B. Return the pre-execution relay and rely on the client to refresh

Consequences: it keeps `submit` cheap, but the user-visible answer on the same turn stays wrong, which is exactly the reported bug. The client cannot repair it because the relay text is already published. Rejected.

### C. Treat duplicate lifecycle actions as failures

Consequences: the model is penalized for following the documented action list, and an operator sees a failure for work that succeeded. Rejected.

## Validation

- `tests/boss-mode-service.test.ts` asserts the final reply contains the worker's real output and not the pre-execution relay.
- The same file asserts a plan listing `create_agent`, `authorize_worker`, and `start_worker` produces no `failed` execution, reports the duplicate start as an explicit skip, and still reaches `reporting` with a recorded report.
- `npm run check`, `npm test`, and `npm run build` are the required gate.

Live evidence (2026-11-15, `workbuddy/blind-model-h`, isolated workspace and database):

- First run: the worker wrote `hello.txt` (`海螺验证成功`) and the Boss reply quoted the read-back text instead of a prepared-work promise.
- Second run: the worker wrote `note.md` (`第二轮验证通过`); the reply quoted the read-back content, and `GET /v1/tasks` showed exactly one task for the turn with a clean eight-event organization sequence.

An attention-producing worker still reaches `waiting_attention`: the relay kind drives the conversation state, and the composed body carries the worker text including its `ATTENTION:` line.

## Consequences

The Boss answer on a turn that awaits work is deterministic and traceable to task output, and the execution list no longer reports success as failure. Turns with no awaited work keep the natural model reply. This changes no public path or schema; `BossModeSubmitResult.reply` remains a bounded string.
