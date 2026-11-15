# Decision 0064: Boss self-review hardening

Status: **accepted and implemented Boss self-review hardening**

Date: 2026-11-15 (Asia/Shanghai).

## Context

Asked to evaluate itself, the Boss produced a specific and largely accurate critique. Verifying each claim against the running system separated real defects from prompt-quality issues:

1. **Real defect — ATTENTION never opened.** Detection used `/^\s*ATTENTION:/`, anchored to the start of the output, while workers emit `ATTENTION:` on its own trailing line. Reports containing a valid attention line were stored as `ready` and no `AttentionRequest` was created.
2. **Real defect — worker instructions were fixed boilerplate.** Every dynamic worker received the same three-sentence template, so a task asking for "exactly two sentences" could not be enforced; workers complied or not by chance.
3. **Real defect — unbounded worker proliferation.** Six near-identical briefer workers accumulated in one project, including three long-term `blocked` ones.
4. **Prompt-quality issues.** Absolute negative claims ("系统里没有任何一段正文"), over-long replies, and rerunning failures without classifying the cause (iteration budget vs. billing).

## Decision

1. Attention detection matches `ATTENTION:` at the start of any line (`(?:^|\n)\s*ATTENTION:`), not only at the start of the output.
2. `create_agent` accepts an optional bounded `instructions` field (4,000 characters). When present, it becomes the Agent's instructions verbatim; the Runtime template is only a fallback.
3. A project may hold at most four non-offboarded workers. Creating a fifth fails with a bounded error telling the caller to reuse or offboard. The limit is a domain rule enforced in `applyOrganizationAction`, not a prompt suggestion.
4. The Boss prompt gains explicit rules:
   - never assert "does not exist" before enumerating existing facts; scope negative claims;
   - quote `reports[].summary` when present and cite `reportId`;
   - keep replies short: conclusion, evidence, 1–3 next steps;
   - classify worker failures; billing/quota errors are reported, never automatically retried;
   - prefer reusing or retrying an existing worker over hiring a similar one;
   - respect the four-worker-per-project limit.
5. No public path or schema changes.

## Options

### A. Only improve the prompt

Consequences: the attention bug and worker proliferation would persist; prompts cannot enforce structural limits. Rejected.

### B. Enforce every rule in code and skip the prompt

Consequences: over-constrains conversational quality and removes model judgment where it is useful. Rejected.

### C. Fix the two structural defects, add a hard limit, and tighten the prompt

Consequences: correctness enforced where it is checkable; tone and reasoning guided where it is not. Accepted.

## Validation

- `tests/boss-mode-service.test.ts` asserts a trailing `ATTENTION:` line creates an open `AttentionRequest`.
- `tests/organization-intent-parser.test.ts` asserts custom worker instructions survive parsing.
- `tests/organization-contract.test.ts` asserts the fifth worker is rejected.
- `npm run check`, `npm test` (266), and `npm run build` pass.

## Consequences

Worker attention now escalates correctly, task-specific output constraints reach the worker, and project worker sprawl is bounded. Conversational quality remains prompt-guided and is expected to improve, not to be guaranteed.
