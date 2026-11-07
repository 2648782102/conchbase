# Decision 0011: Phase-one runtime database instance ownership

Status: **accepted internal persistence boundary; no public API contract changes**

Date: 2026-11-07 (Asia/Shanghai).

## Context

[ADR 0010](0010-first-real-model-slice.md) accepts a phase-1 task/event schema in `node:sqlite`. On startup, `TaskService` changes every persisted nonterminal task to `interrupted` because in-flight model calls cannot be safely resumed. Every CLI command and the HTTP server previously constructed a `SqliteTaskStore`, so running `conchbase tasks`, `conchbase models`, or another CLI command while `conchbase serve` was active could also perform that recovery pass against the live runtime's database. A second writer could silently change active task state and event history.

`docs/AI_HANDOFF.md` still lists multi-process ownership and WAL crash recovery as open decisions. This ADR accepts a narrow development boundary that prevents accidental concurrent ownership; it does not make the SQLite store production-ready, add a locking protocol for legitimate distributed execution, or change `docs/openapi.yaml`.

## Local evidence

A dated two-process experiment on Node `v24.22.2` and `darwin/arm64` used temporary `node:sqlite` databases with `PRAGMA foreign_keys = ON`, `PRAGMA journal_mode = WAL`, and `PRAGMA locking_mode = EXCLUSIVE`. The first process started `BEGIN EXCLUSIVE; COMMIT` and kept its connection open. A second process could open the same file but its WAL or transaction statement failed with `ERR_SQLITE_ERROR`, `errcode 5`, and `database is locked`. After the first connection closed normally, and after its process was killed with `SIGKILL`, a later connection acquired the same lock. A separate same-process experiment confirmed that a second `DatabaseSync` handle receives the same error while the first handle remains open. These observations are local to this Node/SQLite/platform combination and are not a cross-platform production matrix.

## Options

### A. Prose-only guidance

Tell future agents and users not to run two commands against one database.

Consequences: no code change, but accidental CLI use remains capable of interrupting a live server's tasks. It also gives an AI coding agent no deterministic signal when a second owner appears. Rejected.

### B. SQLite exclusive locking for the phase-1 database (recommended)

Set `busy_timeout = 0`, `locking_mode = EXCLUSIVE`, and WAL on each `SqliteTaskStore`, then acquire and release an immediate `BEGIN EXCLUSIVE; COMMIT` during construction. Normalize the narrow `database is locked` error to `DatabaseInstanceError`. Let `conchbase models` use a standalone `MagpieModelCatalog`, so model discovery does not need the runtime database. Keep task reads, writes, cancellation, retry, and events on the owning service.

Consequences: accidental second CLI/service owners fail fast with a stable internal error instead of corrupting recovery semantics. The OS releases the SQLite lock when a process exits, including abnormal exit, so no stale lock file remains. No public schema, route, or error response changes. This is still a single-owner development boundary; it does not provide inter-process task delegation, remote reads, or a production migration and recovery matrix.

### C. Accept concurrent writers now

Add a broker, lease records, leader election, or shared-service API for all CLI reads and writes before the configuration and composition contracts exist.

Consequences: a larger protocol and public-client design, with unresolved approval, event, and recovery semantics. It would prematurely settle open API and persistence decisions. Rejected for phase 1.

## Recommendation

Accept option B as an **internal, phase-1 single-instance boundary**. It follows ADR 0010's explicit-retry decision by ensuring that only the process which owns runtime execution can perform startup interruption. `DatabaseInstanceError` is an internal normalized error; HTTP clients keep the current documented error contract. Do not describe this as multi-process support, production WAL recovery, or authenticated remote operation.

`conchbase models` is intentionally independent of `TaskService` and the SQLite file. Other CLI commands that read or mutate task state continue to own the database for their short lifetime; they must not be used concurrently with `conchbase serve`. A future authoritative client API may replace these direct CLI reads after access control and API parity are accepted.

## Validation

- Deterministic tests assert that a second `SqliteTaskStore` on one file throws `DatabaseInstanceError`, and that reopening succeeds after the owner closes.
- Model-catalog tests use fake `fetch` to check parsing, header shape, invalid payloads, and upstream failures without a database.
- Existing task-service and HTTP tests still cover completion, restart interruption, retry, event replay, and loopback behavior.
- Cross-OS/architecture/Node CI, crash recovery, migrations, retention, and deliberate multi-process execution remain future work in `docs/VALIDATION_PLAN.md`.

No real credentials, personal prompts, public-network calls, or user runtime data are used in the validation.
