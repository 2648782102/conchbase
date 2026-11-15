# Decision 0075: Re-running a worker binds fresh work, and failures name their cause

Status: **accepted and implemented worker re-run and diagnostics fixes**

Date: 2026-11-15 (Asia/Shanghai).

## Context

A live Boss-mode walkthrough asked the Boss to hire a worker, run it, then run the same worker again. Four separate defects surfaced, each hiding the next:

1. `create_agent` failed with `create_agent is missing expectedSequence` even though the Runtime owns that value.
2. Asking the worker to run again failed with `Boss mode execution failed; see bounded execution details` — a summary with no cause.
3. With the cause visible: `WorkItem cannot be transitioned from its current state`. The worker's WorkItem was terminal, and the re-run reused it.
4. After rebinding, `Task is not queued` — the re-run started the task twice, and `startedWorkers` suppressed the dispatch entirely so the fresh task ran unobserved.

The user-visible result was a Boss that reported on the old result while a new task ran in the background.

## Decision

1. **`expectedSequence` is filled before validation** (recorded separately in ADR 0074).
2. **A failed Boss execution names its first concrete reason.** A bare "execution failed" forces the operator to dig and hides actionable causes.
3. **Resuming or re-starting a worker whose WorkItem is terminal binds a new task and WorkItem.** Reusing a finished WorkItem can never start; it only produces a conflict. The previous binding remains in history.
4. **`startedWorkers` no longer suppresses a legitimate re-run.** It still prevents a duplicate dispatch while the latest task is genuinely in flight, but once that task is terminal the marker is cleared so the next `start_worker` runs.
5. **A dispatched re-run is awaited like a fresh hire.** Otherwise the Boss answers from stale data while the new task is still running.
6. **Non-`Error` throwables keep a diagnostic.** `boundedError` stringifies them instead of collapsing everything into `Unknown execution failure`.

## Options

### A. Reject a re-run and require a new worker

Consequences: a transient failure would permanently consume a worker and a project slot, and the Boss would be pushed into hiring near-identical replacements — the exact spam behaviour ADR 0064 already fixed. Rejected.

### B. Reuse the terminal WorkItem and force it open

Consequences: it bypasses the work-state machine, which is the authority for work lifecycle. Rejected.

### C. Bind fresh work on re-run and surface the real cause on failure

Consequences: re-runs work, history stays intact, and an operator sees why something failed. Accepted.

## Validation

- `tests/organization-intent-parser.test.ts` covers sequence fill, report-id fill, and SSE/JSON response handling.
- `tests/boss-mode-service.test.ts` covers the worker prompt contract and the configured Boss model.
- Live walkthrough: three consecutive worker runs each produced a report, and the final answer quoted the real count (100 recursive Markdown files under `docs`, verified with `find docs -type f -name '*.md' | wc -l`).
- `npm run check`, `npm test` (324), and `npm run build` pass.

## Consequences

The Boss can re-run a worker and see the new result. Failures explain themselves. Work-item history is preserved because a re-run creates a new binding instead of mutating a finished one.

## Correction recorded

While investigating this walkthrough I concluded the worker had hallucinated its count, because `ls docs/*.md` returned 22 while the worker reported 100. That was my error: the worker was asked for a **recursive** count, and `find docs -type f -name '*.md'` returns exactly 100. The worker was correct.

No change in this ADR depends on the mistaken conclusion. The worker prompt was tightened anyway for a related and genuine reason: the previous wording ("do not list directories") discouraged the tool use the task required. The lesson: verify the measurement before concluding the model is wrong, and check that the question asked matches the question answered.
