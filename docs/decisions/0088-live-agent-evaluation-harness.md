# Decision 0088: Live agent evaluation harness

Status: **accepted and implemented**

Date: 2026-11-16 (Asia/Shanghai).

## Context

ADR 0087 made agent behaviour testable by scripting the model. That proves the Runtime carries state correctly, but it cannot answer the question a user actually has: given a task it has not seen, does a real model, running through this Runtime, produce a correct result?

The existing `scripts/probe-agent-chat.mjs` sends one question and prints a trace. It has no assertions, no isolation between runs, and no budget sized for real work — with the default `maxIterations=6` and a 120-second deadline, a task that needs ten file reads cannot finish.

## Decision

1. **A separate evaluation harness, not a test.** `evals/harness.mjs` drives a real model through the real HTTP Runtime. It is deliberately outside `npm test`: it needs a live gateway, costs money, and is non-deterministic. The deterministic suite stays the merge gate.
2. **Isolation per run.** Each run starts a Runtime on its own port with a fresh SQLite database and a fresh temporary workspace, and shuts it down afterwards. Nothing touches the developer's checkout or the main runtime database.
3. **Budgets sized for long tasks.** Defaults are 40 iterations, a 15-minute loop deadline, and a 15-minute per-task timeout, all overridable. The production defaults stay conservative; an evaluation is not production traffic.
4. **Assertions on artefacts and boundaries, never on wording.** Each task checks the workspace and the trace. The `refactor` task goes further and executes the modified code, because "the diff looks right" is not evidence that the code works.
5. **A task contract, not free-form prompts.** Each module declares its id, instructions, tool grants, fixture, prompt, and an `assert({ run, read, before })`. Tool grants are explicit per task, so the capability boundary is part of the fixture.
6. **Reports are machine-readable and git-ignored.** Every run writes `evals/reports/<timestamp>.json` with the model, budgets, per-task verdict, elapsed time, turn and tool counts, and the workspace snapshot. The report is diffable; the directory is ignored so results are not committed noise.
7. **The harness must be able to fail.** A deliberately failing task was run to confirm a non-zero exit and a FAIL line. The first check reported exit 0 only because the shell pipeline's `tail` status was measured instead of the harness's; re-measuring with `pipefail` showed exit 1.

## Current tasks

| Task | Proves |
| --- | --- |
| `inventory` | Multi-file discovery and aggregation written to an artefact whose counts can only be right if every file was read. |
| `refactor` | A bug fix verified by running the code against four cases, not by inspecting the diff. |
| `boundary-escape` | Host-file access is refused and never fabricated; the answer must admit the limitation. |
| `long-chain` | Four dependent steps; one wrong value makes the final JSON wrong. |
| `insufficient-budget` | Under a tight budget, an incomplete artefact must not be reported as complete. |
| `context-switch` | A mid-task requirement change supersedes the earlier artefact. |

## Options

### A. Put these in CI

Consequences: non-deterministic, credential-dependent, and slow; a flaky model response would block merges unrelated to it. Rejected.

### B. Keep using the single-shot probe

Consequences: it prints a trace but asserts nothing, so "it replied" passes even when the artefact is wrong. Rejected.

### C. Record real transcripts and replay them

Consequences: realistic and fast, but transcripts encode one model's quirks as the contract and go stale as prompts change. Rejected for now.

## Consequences

Real-model behaviour is now observable and regression-diffable without polluting CI, and each task costs roughly 7–22 seconds of model time. The harness measured 6/6 on `workbuddy/blind-model-h` at the time of writing; that result describes one model on one day and is stored in a report, not asserted as a permanent claim.

The honest limit: an eval passing does not mean the agent is good at everything, only that these six boundaries held for this model on this run.
