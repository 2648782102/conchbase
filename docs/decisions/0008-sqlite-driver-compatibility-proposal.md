# Decision 0008: SQLite driver compatibility spike (proposal)

Status: **proposed, not accepted as a public contract**

Date: 2026-11-07 (Asia/Shanghai). This is a dated, local compatibility observation. It does not accept a production driver, persistence schema, storage interface, or public API.

## Context

`docs/TECH_STACK.md` plans SQLite behind a narrow storage interface, and `docs/AI_HANDOFF.md` lists the Node SQLite driver and persistence schema as open decisions. The runtime currently has no persistence. Public task, event, configuration, composition, provider, and extension contracts remain product-direction blocked in ADRs `0002`–`0007`.

Before a future persistence slice can be designed, a coding model needs evidence about whether Node 24's built-in SQLite module and two common npm drivers can atomically write a task-like row and an event-like row, roll back a failed event insert, and recover a committed pair after reopening the database. This spike answers only that narrow compatibility question.

## Method

- Work happened on a scratch Git branch and in a scratch npm project outside the repository. Conchbase `src/`, `package.json`, `package-lock.json`, `docs/openapi.yaml`, and CI were not modified. Runtime code gained no driver.
- Local environment: Node `v24.22.2`, npm `11.19.1`, `darwin/arm64`, built-in SQLite `3.53.4`, and `@types/node` `24.19.2`. The installed `@types/node` declarations include `node:sqlite` and mark the module experimental.
- Dated npm metadata observed during the spike: `better-sqlite3@13.0.3` is MIT, declares Node `>=22`, and has no bundled TypeScript declarations; `sqlite3@6.0.1` is BSD-3-Clause, declares Node `>=20.17.0`, and bundles TypeScript declarations. These values are a time-sensitive snapshot, not a permanent compatibility guarantee.
- Candidate packages were installed only in the scratch npm project using exact versions. `better-sqlite3` supplied native prebuilds for several platforms. `sqlite3` supplied a native binary through its install path; npm reported `prebuild-install@7.1.3` as deprecated and warned that `sqlite3@6.0.1` had an install script not covered by `allowScripts`. The transaction test itself used no real credentials, personal data, external service calls, or network access.
- Each candidate ran the same deterministic sequence on a temporary file database:

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
CREATE TABLE task (id TEXT PRIMARY KEY, label TEXT NOT NULL) STRICT;
CREATE TABLE event (
  seq INTEGER PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES task(id),
  dedupe_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL
) STRICT;
BEGIN;
INSERT INTO task (id, label) VALUES ('rollback-task', 'rollback fixture');
INSERT INTO event (seq, task_id, dedupe_key, kind) VALUES (1, 'rollback-task', 'duplicate-key', 'task.created');
INSERT INTO event (seq, task_id, dedupe_key, kind) VALUES (2, 'rollback-task', 'duplicate-key', 'task.started');
ROLLBACK;
BEGIN;
INSERT INTO task (id, label) VALUES ('commit-task', 'commit fixture');
INSERT INTO event (seq, task_id, dedupe_key, kind) VALUES (1, 'commit-task', 'created-1', 'task.created');
COMMIT;
```

The third insert violates `event.dedupe_key`'s unique constraint. The test asserted that the failure was observed, the rollback left zero task and event rows, the second transaction committed one joined task/event row, and that row remained after closing and reopening the database. The SQL above shows the statements; the scratch harness supplied distinct fixture values and wrapped each candidate's API without changing the sequence.

## Results

| Candidate | SQLite reported | Duplicate-key error | Rollback | Commit and reopen | Other observations |
|---|---|---|---|---|---|
| `node:sqlite` `DatabaseSync` | `3.53.4` | `ERR_SQLITE_ERROR`, `errcode 2067`, "constraint failed" | Pass | Pass | Zero npm runtime dependencies, synchronous prepared statements, first-party `@types/node` declarations, module marked experimental, requires the project's Node 24+ baseline. |
| `better-sqlite3@13.0.3` | `3.53.4` | `SqliteError`, `SQLITE_CONSTRAINT_UNIQUE` | Pass | Pass | Synchronous prepared statements, multiple bundled native prebuilds, one runtime dependency (`node-addon-api`), no bundled TypeScript declarations, and no install-script warning observed. A separate `@types/better-sqlite3@9.6.0` existed in npm metadata at the time of the spike. |
| `sqlite3@6.0.1` | `3.52.0` | `Error`, `SQLITE_CONSTRAINT` | Pass | Pass | Callback-based API and bundled TypeScript declarations. More transitive dependencies, a deprecated install helper, an npm install-script warning, and a compile fallback. |

All three candidates passed the narrow transaction sequence on this one machine. Error names and codes differ between drivers, so driver-specific errors must not become the future public API. The result does not establish support for other operating systems, CPU architectures, Node versions, CI runners, concurrent writers, crash recovery under WAL, migrations, or long-term API stability. The test is not part of `npm test` or GitHub Actions.

## Options

### A. Built-in `node:sqlite`

Use Node's `DatabaseSync` behind a narrow internal storage interface for the first persistence conformance prototype.

Consequences: no added runtime dependency or native-module install path, TypeScript declarations ship with the installed `@types/node`, and the synchronous API makes a task/event transaction explicit. The module is experimental; its behavior, error codes, and available options can change between Node releases. A production choice still needs a supported-platform CI matrix and an accepted persistence schema.

### B. `better-sqlite3`

Use the third-party synchronous driver and its transaction helpers.

Consequences: a stable-feeling synchronous API and bundled native prebuilds, at the cost of an external native dependency, platform/ABI coverage checks, a separate type package, and a larger supply-chain surface. Its error vocabulary still needs normalization.

### C. `sqlite3`

Use the callback-based driver and wrap it in promises or a unit-of-work helper.

Consequences: bundled TypeScript declarations and an asynchronous API that may fit a future I/O scheduler, but the spike also exposed an install-script warning, a deprecated install helper, more transitive dependencies, and extra coordination to keep a task/event transaction atomic. Its bundled SQLite version differed from the built-in module in this snapshot.

### D. Defer acceptance (recommended now)

Keep all drivers outside Conchbase runtime dependencies and record only this evidence.

Consequences: no unverified native dependency reaches CI or downstream users, and the storage boundary remains replaceable. A future coding model must still obtain product direction, design the persistence schema, and run a supported-platform compatibility matrix before restart/resume behavior can be trusted.

## Recommendation

Accept option D for the current repository state. Treat option A as the recommended **first prototype candidate only after** ADRs `0002`–`0007` receive the product direction they need; keep option B as a synchronous-driver fallback, and option C only if an asynchronous boundary proves worth its install and dependency complexity.

The future storage interface should own an explicit transaction boundary for atomic task/event writes, normalize constraint and transaction errors, and keep driver handles out of HTTP handlers and agent-domain modules. It must not leak SQLite error names, native addon types, or a specific SQLite version into the public Runtime API. `docs/openapi.yaml` stays unchanged because no current endpoint changed.

Do not add `node:sqlite`, `better-sqlite3`, `sqlite3`, `@types/better-sqlite3`, or any other storage driver to Conchbase `package.json` or `package-lock.json` on the basis of this ADR. Do not claim persistence, restart/resume, WAL crash recovery, cross-platform support, or a production driver is implemented.

## Validation

The scratch spike is a dated observation, not automated repository coverage. Future work must add deterministic tests for:

- atomic task/event writes and rollback under the accepted storage interface;
- normalized unique-constraint, transaction, and migration errors;
- committed rows surviving process restart and schema migration;
- supported OS, architecture, and Node-version combinations in CI;
- WAL behavior, crash recovery, and multi-process ownership;
- no driver-specific error or type leaking into `docs/openapi.yaml` or generated clients.

See `docs/VALIDATION_PLAN.md` for the current automated baseline and future validation layers.
