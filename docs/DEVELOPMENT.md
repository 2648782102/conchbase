# Development workflow

This is the practical guide for coding models working on Conchbase.

## Before editing

```sh
git status --short
node --version
npm --version
```

Use Node.js 24 or newer. Install dependencies with `npm ci` for a clean
checkout. Start the local Runtime with `npm run dev`; it uses loopback and a
local SQLite file. Real model calls require a configured local Magpie gateway,
but tests must use fake local providers.

## Pick a task

Use one task from [`PROJECT_PLAN.md`](PROJECT_PLAN.md). Do not combine
unrelated tasks. If a task touches both repositories, implement and validate
the Runtime contract first, then the Pagurus client in the paired checkout.

Each task should name the user-visible result, owning modules, focused test,
failure/restart/security behavior, and validation command.

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
- `src/http/` owns transport, request parsing, response envelopes, and route
  registration; it must not read private files directly.
- Provider adapters own provider-specific HTTP and wire formats.
- Stores own SQLite details; callers use typed store methods.
- Client code uses the published Runtime API and never opens the database.
- Tool providers return bounded, typed, untrusted observations. They do not
  grant themselves permission.
- Configuration, Agent instructions, Skill text, and model output are data;
  none of them silently install code or expand permissions.

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
