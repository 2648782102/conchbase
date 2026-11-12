# Decision 0029: Persistence test boundary

Status: **accepted repository development boundary; no public API contract changes**

Date: 2026-11-12 (Asia/Shanghai).

## Context

ADR 0026 accepts AI handoff readiness and records persistence hardening as an ADR-gated proposal. ADR 0028 closes the executable interface-validation slice and leaves `persistence-hardening` as the only bounded proposal in `docs/PROJECT_STATUS.json`. The runtime already uses one `node:sqlite` `DatabaseSync` owner with WAL, exclusive locking, transactional task/event writes, additive migrations, restart interruption, and durable work recovery. Existing tests prove normal close/reopen paths and one agent-schema migration, but do not provide a named fixture for abrupt process exit, WAL recovery, migration preservation, and environment portability of the test harness.

The exact 47-path OpenAPI, work contract version 2, `user_version = 3`, process-scoped SecretHandles, and all accepted Runtime behavior remain frozen. CI must stay deterministic, credential-free, and independent of machine-specific absolute paths. This ADR accepts only the test boundary that makes those claims executable; it does not accept multi-process writers, a production driver, retention policy, or real external recovery.

## Options

### A. Claim production persistence from the existing tests

Consequences: no new artifact, but normal close/reopen fixtures do not prove committed WAL state survives abrupt process exit, and the status file would overstate coverage. Rejected.

### B. Add a child-process crash fixture and a supported-baseline matrix

Consequences: deterministic local evidence for abrupt exit recovery and portable temporary paths, while making clear that the current Node 24/Linux CI baseline is not a cross-platform production matrix. Accepted.

### C. Add multi-process writers and a leader protocol now

Consequences: would change the accepted single-owner boundary and require unresolved public API, authorization, and recovery contracts. Rejected.

## Decision

1. `tests/persistence-conformance.test.ts` is an executable, credential-free persistence fixture. It creates a temporary database through `node:os.tmpdir()`, uses a one-shot child process that commits a task and its queued event and exits without closing the store, then reopens the database in the test process and asserts the committed task/event state and continuing monotonic event ids.
2. The same fixture creates a pre-`user_version = 3` SQLite database with legacy task, event, configuration, and tool-request rows, opens `SqliteTaskStore`, and asserts that the Agent/platform migration preserves those rows, sets `user_version = 3`, rejects a second simultaneous owner, and permits reopening after the first owner closes.
3. `docs/PROJECT_STATUS.json` records `persistence-conformance-fixture` in `validationEvidence` with `executableFixture: true`. The `persistence-hardening` proposal is removed; no `ready` bounded slice is introduced.
4. CI remains on the accepted Node 24 Ubuntu baseline. The fixture uses cross-platform Node path helpers rather than hardcoded `/tmp` paths in new test code. Linux/macOS Node 24 and multi-OS/architecture matrices remain deployment evidence outside this accepted test boundary.
5. No dependency, public route, schema, driver, database owner, retention policy, external write, generic secret resolver, credential, user data, or machine-specific path is added or changed. The `v1.0.0` release, tag, and assets remain immutable.

## Validation

- Conchbase: `npm run check`, `npm test`, and `npm run build`.
- The child process uses `process.exit` only after the store commits; the parent asserts the reopened state instead of trusting child output.
- Guardrails assert the new ADR status, package test registration, fixture evidence, portable temporary-path usage, and the absence of a stale `persistence-hardening` proposal.
- No test calls a model provider, external service, real credential, or private user database.

## Consequences

A later coding model can identify abrupt-exit WAL recovery and additive migration preservation as executable validation evidence rather than prose claims. This is still the accepted single-owner local-first boundary: it does not prove production storage durability, multi-process delegation, event retention, WAL behavior under arbitrary crash points, or cross-platform driver support. Those changes require separate accepted contracts and a broader CI matrix.

> Development boundary only: this ADR closes the repository's persistence test-boundary slice; it does not accept a new storage driver, public API, retention policy, multi-process ownership, or release.
