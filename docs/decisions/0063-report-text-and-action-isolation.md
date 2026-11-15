# Decision 0063: Durable report text and per-action failure isolation

Status: **accepted and implemented durable report text and per-action isolation**

Date: 2026-11-15 (Asia/Shanghai).

## Context

Live use of Boss mode exposed three coupled defects:

1. Worker output was reduced to a digest when recording a report, so neither the user nor the Boss could read what a worker actually produced. The Boss could only say "正文未保留".
2. A single invalid action aborted the whole turn. A malformed `model` field on one `create_agent` action produced `Boss Agent 提交失败`, discarding the rest of a valid plan.
3. Workers started with a prompt that gave no project facts, so they searched the workspace for "project context" that does not exist there and burned the 6-iteration budget.

## Decision

1. Private SQLite gains `organization_report_texts(report_id, body, recorded_at)`. It stores bounded worker output (4,000 characters) alongside the existing digest.
2. `OrganizationStore` gains optional `recordReportText` / `reportTexts`. `SqliteOrganizationStore` implements them; in-memory fixtures remain valid.
3. `BossOrganizationFacts.reports` carries a bounded `summary` in addition to the digest, so the Boss can quote worker output.
4. A backfill runs when building Boss facts: any report without stored text is reconstructed from the worker's task output. This also repairs reports recorded before this decision.
5. Boss actions are applied individually. One failing action becomes a `failed` execution entry; remaining actions still run. A turn fails only when **every** action failed.
6. A `create_agent` action whose `model` is not a `{providerId, modelId}` object is corrected to the Runtime's resolved model reference before validation, instead of rejecting the whole action.
7. Worker prompts now include the project purpose, authorized scope, granted capabilities, and an explicit statement that organization facts live in the Runtime rather than the workspace, so workers stop searching files for them.

## Options

### A. Keep digest-only reports

Consequences: the Boss cannot report results and the user cannot read worker output. Rejected.

### B. Fail the whole turn on one bad action

Consequences: a single malformed field discards an otherwise valid plan. Rejected.

### C. Persist report text, isolate action failures, and give workers real context

Consequences: worker results are readable, partial plans still execute, and workers converge. Accepted.

## Validation

- `tests/organization-persistence.test.ts` covers report text persistence across reopen.
- `tests/boss-mode-service.test.ts` covers per-action isolation (one failed action, one successful action).
- `tests/organization-intent-parser.test.ts` covers replacing a malformed agent model with the Runtime reference.
- Live verification: the Boss read back a worker's original report text verbatim, and a new worker completed instead of exhausting iterations.
- `npm run check`, `npm test` (263), and `npm run build` pass.

## Consequences

Workers produce readable results, partial plans degrade gracefully, and worker tasks converge on the first attempt. Report text stays bounded and local; no new authority is granted and organization actions remain fully validated.
