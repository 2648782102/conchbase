# Decision 0069: Operator-configurable Agent loop budget

Status: **accepted and implemented operator loop budget**

Date: 2026-11-15 (Asia/Shanghai).

## Context

ADR 0052 states that hard bounds are "part of the contract, not tuning knobs exposed to a model", and ADR 0053 fixes the iteration ceiling at 12 with a default of 6. Both statements are about what a **model** may do. They do not say an operator can never choose a larger ceiling.

Live use produced the case those documents left open. In unrestricted mode an Agent that reads several files in sequence hits `Agent loop exceeded 6 iterations` and fails, even though every individual call was permitted and nothing went wrong. The bound stopped a legitimate multi-step task, and the only remedy available was editing source.

The risk the bound protects against is a model spinning forever. That risk does not change when a human deliberately raises a ceiling, because the ceiling still exists and still fails the task.

## Decision

1. The Agent loop budget becomes operator configuration, read once at process start:
   - `CONCHBASE_MAX_ITERATIONS` — default `6`, accepted range `1`–`64`.
   - `CONCHBASE_MAX_TOOL_CALLS_PER_TURN` — default `4`, accepted range `1`–`16`.
   - `CONCHBASE_LOOP_DEADLINE_MS` — default `120000`, accepted range `1000`–`1800000`.
2. These are environment settings on the Runtime process. They are **not** task fields, Agent revision fields, request bodies, or values a client may send. A model cannot read, request, or extend them.
3. The bound remains a bound. Exceeding it still fails the task with a bounded error, and the error message names the configured limit so an operator can tell the budget apart from a genuine failure.
4. Defaults are unchanged from ADR 0053, so existing behaviour is preserved unless an operator deliberately raises a limit.
5. Invalid values are rejected at startup with an explicit error rather than silently falling back, because a silently ignored security-adjacent setting is worse than a failed boot.
6. The effective budget is published on `GET /v1/runtime` as `loopBudget: { maxIterations, maxToolCallsPerTurn, deadlineMs }`, so an operator can confirm what the process is actually running rather than what the environment file claims.
7. No public path is added. The existing iteration, tool-call, context, and deadline checks are unchanged in shape; only their numeric ceilings become configurable.

## Options

### A. Keep the ceilings hard-coded

Consequences: legitimate multi-step work fails, and the only remedy is a source change and redeploy. Rejected.

### B. Let the model request more iterations

Consequences: directly violates ADR 0052 — a model could grant itself unbounded work. Rejected.

### C. Operator-set ceilings, published and validated

Consequences: a human chooses the budget; the model still cannot influence it; misconfiguration fails loudly. Accepted.

## Validation

- `tests/runtime-config.test.ts` asserts defaults, the accepted ranges, and rejection of `0`, a non-integer, and an out-of-range value.
- `tests/execution-mode.test.ts` asserts the loop honors a raised `CONCHBASE_MAX_ITERATIONS` and still fails when the raised ceiling is exhausted.
- `tests/http-api.test.ts` asserts `loopBudget` is published on `GET /v1/runtime`.
- `npm run check`, `npm test`, and `npm run build` pass.

## Consequences

Operators can tune the loop to their workload without weakening the rule that a model never controls its own budget. Raising a ceiling permits longer legitimate work and equally permits a longer spin; the deadline and context budget remain independent limits, and the failure mode stays visible.
