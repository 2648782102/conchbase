# Decision 0079: Entry-document merge policy for parallel sessions

Status: **accepted and implemented status-slice merge policy**

Date: 2026-11-15 (Asia/Shanghai).

## Context

ADR 0078 makes ports, databases, and workspaces per-checkout. It explicitly
leaves one problem open: the entry documents are single files that every session
edits, so parallel branches conflict there.

Measured on this repository:

- `docs/PROJECT_STATUS.json` held 55 `implemented` records and 34
  `validationEvidence` records.
- Five consecutive commits each modified that one file to append a record.
- ADR numbers were chosen by reading the highest and adding one.

An append to a JSON array is a near-guaranteed conflict when two branches do it,
and the conflict is a brace-level merge in a 34 KB file. ADR numbering has the
same shape: both sessions reserve the same number, and the duplicate is only
visible after both files exist.

## Decision

1. The two append-only arrays of `docs/PROJECT_STATUS.json` are sourced from one
   file per record under `docs/status/implemented/` and
   `docs/status/validationEvidence/`. Adding a record adds a file, which Git
   merges without conflict.
2. `scripts/status-slices.mjs` provides `split`, `merge`, and `check`. `merge`
   regenerates the published JSON so the readable artifact keeps its shape and
   every existing reader is unaffected.
3. `check` runs inside `npm test` via the repository guardrails. If the published
   JSON and the slices disagree, the suite fails with the exact command to fix
   it.
4. Duplicate ids across slices are a hard error, so a careless copy shows up
   immediately instead of silently producing two records with one id.
5. ADR numbers are reserved by `scripts/next-adr.mjs`, which creates the file
   with an exclusive open. A lost race increments and retries rather than
   producing a duplicate number.
6. The remaining single-file documents (`docs/AI_TASK_QUEUE.md`, `README*.md`,
   `docs/openapi.yaml`) keep the merge rule stated in
   `docs/PARALLEL_DEVELOPMENT.md`: fetch and rebase before pushing, and merge
   both sides' content rather than overwriting one.

## Options

### A. Keep the arrays in one file and resolve conflicts by hand

Consequences: every parallel branch conflicts in the same file, and resolution
requires understanding the whole record set. This is the observed cost. Rejected.

### B. Move status entirely to a database or generated site

Consequences: the status stops being reviewable as a diff in a pull request, and
agents lose the plain-file entry point the project depends on. Rejected.

### C. One file per record, published file regenerated, drift checked in CI

Consequences: additions are conflict-free, the published artifact is unchanged,
and drift is impossible to merge unnoticed. Accepted.

## Validation

- `node scripts/status-slices.mjs split` produced 55 + 34 slice files and left
  the published JSON with empty arrays.
- `merge` then `check` round-tripped back to 55 + 34 records, and every
  non-sliced key was byte-identical to the pre-split file.
- The new guardrail test runs `check` and fails the suite when the two disagree.
- `node scripts/next-adr.mjs` reserved `0078` and `0079` consecutively without a
  collision and exits non-zero only when it cannot reserve any number.
- `npm run check`, `npm test`, and `npm run build` pass.

## Consequences

Two sessions can add records to the project status independently and merge
without touching the same lines. The published status file remains the single
artifact a reader or an agent opens first.

Conflict is reduced, not eliminated: narrative documents still merge by hand.
The policy is to rebase before pushing and to keep both sides, which is stated
where a session will actually read it.
