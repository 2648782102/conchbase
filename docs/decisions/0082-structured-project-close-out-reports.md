# Decision 0082: Structured project close-out reports

Status: **accepted and implemented**

Date: 2026-11-16 (Asia/Shanghai).

## Context

ADR 0081 made the Runtime close an idle project on its own, but the report it published was assembled mechanically: a header with counts plus the last few worker report bodies. That is faithful but not useful. A user who comes back to an archived project wants to know what it actually achieved, what was left open, and what resuming would involve — the close-out report the Organization Runtime target describes in section 3.6 step 2.

The target also states this report must be structured and Runtime-owned, not free prose the model chooses to produce.

## Decision

1. **A project report is a distinct document type.** `ProjectSummaryDocument` carries `headline`, `outcomes`, `openIssues`, `nextSteps`, a `projectId`, a version, and a `source` of `model` or `runtime`. It is not a worker `OrganizationReport`, which describes one task.
2. **One bounded model call may write it.** The Runtime sends only project-local facts: the recorded purpose, worker names and states, and bounded report bodies. It asks for strict JSON and parses the reply through `parseProjectSummary`.
3. **The shape is Runtime-owned.** Unknown fields, oversize strings, empty headlines, and secret-like values are rejected rather than partially accepted. A rejected summary is discarded wholesale.
4. **The deterministic summary is the floor.** Provider outage, timeout, malformed JSON, or a rejected shape all produce `deterministicProjectSummary`, which states real counts and quotes stored report bodies. Convergence never depends on a provider being reachable; otherwise a finished project would stay active forever.
5. **The report is persisted once, keyed by project.** It is written to private `organization_project_summaries` before the archive actions run, so the record survives restart even though the project is closed.
6. **The published text is rendered from the document.** `renderProjectSummary` produces the bounded text the Boss conversation shows, so the user sees the structured fields rather than a second model paraphrase.
7. **The summarizer is configured like the Boss conversation.** It reuses `CONCHBASE_BOSS_MODEL` (falling back to the default model) and the Magpie compatibility endpoint. No new public route, schema, or operator setting was added.

## Options

### A. Keep the mechanical summary

Consequences: zero cost and zero risk, but the archived project has no usable conclusion, which is the main reason to keep the history. Rejected.

### B. Let the Boss model write free prose at convergence

Consequences: fluent, but the stored artifact is unverifiable text, clients cannot render specific sections, and a single bad completion becomes the permanent record of the project. Rejected.

### C. Block convergence until a model summary succeeds

Consequences: one provider outage would keep every finished project alive, holding worker authority and confusing the user. Rejected.

### D. Structured model attempt with a deterministic floor

Consequences: the common case is a useful structured report, the failure case is dull but true, and convergence timing is unaffected. Accepted.

## Limits

- Headline 240 characters; up to 6 outcomes, 4 open issues, and 3 next steps, each at most 320 characters.
- Rendered text is capped at 3,800 characters.
- The summarizer request is capped at 30 seconds and never streams.
- Only project-local facts are sent: no other project's reports, no transcripts, no secrets, no private paths.

## Validation

- `tests/project-summary.test.ts` covers accepted output, rejection of unknown fields, empty headlines and secret-like text, deterministic counts, generator failure modes, and fact collection scope.
- `tests/organization-convergence.test.ts` covers using a model summary, persisting it, and proving a throwing summarizer still converges.
- Live probe (2026-11-16, `workbuddy/blind-model-h`, isolated database): a worker wrote and read back a file, the project archived automatically, the Boss conversation showed a structured close-out report, and `organization_project_summaries` held the same document with `source: "model"`.

## Consequences

An archived project now has a durable, structured conclusion that a client can render section by section, and the user's conversation receives it without an extra turn. The deterministic path guarantees the loop still closes offline. No public contract changed; the private schema gains one additive table, and the database `user_version` is unchanged because `migrateOrganizationSchema` creates it idempotently.
