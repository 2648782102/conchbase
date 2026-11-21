# Development workflow

This is the practical guide for coding models working on Conchbase.

## Before editing

```sh
git status --short
node --version
npm --version
```

Before starting, run `conchbase diagnose`. It checks the Node version,
database and workspace paths, the Runtime port, the Magpie gateway, and
whether the console is up, and prints one line per check.

Use Node.js 24 or newer; `.nvmrc` pins it, so `nvm use` selects the right
version. Both entry points (`conchbase` and `npm run dev`) refuse to start on
an older interpreter with one clear message instead of a deep runtime error.
Install dependencies with `npm ci` for a clean checkout. Start the local Runtime with `npm run dev`; it uses loopback and a
local SQLite file. Real model calls require a configured local Magpie gateway,
but tests must use fake local providers.

## Pick a task

Use one task from [`PROJECT_PLAN.md`](PROJECT_PLAN.md). Do not combine
unrelated tasks. If a task touches both repositories, implement and validate
the Runtime contract first, then the Pagurus client in the paired checkout.
See [`PAIRED_DEVELOPMENT.md`](PAIRED_DEVELOPMENT.md) for cross-repo mechanics.

Each task should name the user-visible result, owning modules, focused test,
failure/restart/security behavior, and validation command.

## Focused tests and the smoke check

`npm test` runs everything. For one layer, list the suites and run one:

```sh
npm run test:suite -- --list
npm run test:suite -- --suite domain
```

`npm run smoke` starts the real Runtime on a free port with a temp database,
checks health/runtime/discovery, creates one task (skipped without a gateway),
and confirms a clean SIGTERM shutdown.

## Change loop

1. Read the task and its dependencies.
2. Inspect the current implementation and existing tests.
3. Write a failing focused test for behavior changes.
4. Implement the smallest complete vertical slice.
5. Run the focused test, then the standard checks.
6. Update current-state documentation only when behavior changed.
7. Review the diff for unrelated edits, secrets, and accidental API changes.

## Boundaries

- `src/runtime/` owns domain behavior and must not depend on Fastify.
- `src/http/` owns transport, parsing, response envelopes, and route
  registration; it must not read private files directly.
- Provider adapters own provider-specific HTTP and wire formats.
- Stores own SQLite details; clients use the published API, never the database.
- Tool providers return bounded, typed, untrusted observations. They do not
  grant themselves permission.
- Configuration, Agent instructions, Skill text, and model output are data.

## When to change the API

First write the intended request, response, state transitions, errors, and
security behavior in the owning contract document and tests. Update
`docs/openapi.yaml`, Runtime discovery, client types, paired tests, and user
docs in the same slice. Do not add a route only because it is convenient for a
single screen.

## When to change architecture

Make the smallest change that improves the personal product. If the current
design is wrong, update `ARCHITECTURE.md`, `CURRENT_STATE.md`, and
`PROJECT_PLAN.md` in the same slice. Do not preserve obsolete ceremony.

## Reporting format

End each coding task with:

- summary of user-visible behavior;
- changed files;
- focused tests and full checks run;
- failures or environment limits;
- security/recovery considerations;
- the next recommended task.

## Upgrading and rolling back

The schema has one version per release. An older database is upgraded in place
on open; a newer one is refused with a clear error rather than half-read.

Before an upgrade, take a snapshot and confirm it:

```sh
conchbase backup ./runtime-before-upgrade.sqlite
conchbase verify-backup ./runtime-before-upgrade.sqlite
```

Then start the new version. It migrates forward automatically. To roll back:

```sh
conchbase stop
# verify the snapshot, replace the live database, then start the OLD version
conchbase restore-backup ./runtime-before-upgrade.sqlite
conchbase start
```

`restore-backup` verifies before replacing, re-verifies the staged copy, keeps
the previous database as `<database>.before-restore-<timestamp>`, and refuses to
run while a Runtime owns that file.

A backup from an older release is readable by that release. Never expect a
newer binary's migrated file to downgrade — restore the pre-upgrade snapshot.
