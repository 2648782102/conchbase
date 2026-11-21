# Paired development: Runtime + Pagurus

One guide for working across both repositories. Read `START_HERE.md` and
`PROJECT_PLAN.md` first; this file covers the mechanics that span repos.

## The two repositories

| Repo | Role | Path |
|---|---|---|
| Conchbase | Runtime: model calls, state, tools, permissions, API | this checkout |
| Pagurus | Console: an API client, never owns state | `pagurus/` (nested checkout) |

The console talks to the Runtime only through its HTTP API. If a change needs
both, land and validate the Runtime contract first, then update Pagurus.

## Requirements

- Node.js 24+ (`.nvmrc` pins it; `nvm use`).
- A local Magpie gateway for real model calls (`CONCHBASE_MAGPIE_URL`,
  default `http://127.0.0.1:3425`). Tests and paired fixtures never need it.

### A second model provider

`openai-compatible` is registered but deliberately not configured by default.
Point it at its own loopback gateway with:

```sh
CONCHBASE_PROVIDER_ENDPOINTS='{"openai-compatible":{"baseUrl":"http://127.0.0.1:8123","appKey":"..."}}'
```

Each provider then publishes its own models as `<providerId>:<modelId>` and its
requests carry that provider's own credential; nothing falls back to Magpie.
Naming a provider with no endpoint fails with a clear error instead of quietly
using another gateway. Ids must be registered and URLs must be loopback.

## Ports and databases

Ports and SQLite paths are derived from the checkout, so parallel worktrees do
not collide:

| Checkout | Runtime port | Console port | Database |
|---|---|---|---|
| default checkout | 4318 | 5173 | `<checkout>/.conchbase/runtime.sqlite` |
| linked worktree | 4320–4399 (hashed from branch) | `5173 + (runtimePort − 4318)` | per-worktree path |

The 4318 row is the checkout that owns `git-common-dir` — the original clone.
A `git worktree` (including one created for a parallel session) is a linked
checkout even when it holds `main`, so it takes a hashed port and its own
database directory. `node -e "import('./scripts/worktree-env.mjs').then(m => console.log(m.resolveWorktreeEnv()))"`
prints the values for the checkout you are standing in; `.conchbase/session.json`
records them too.

Both `scripts/worktree-env.mjs` (Runtime) and `pagurus/vite.config.ts`
(console) compute the same number from the branch. The console points at the
matching Runtime; override with `CONCHBASE_URL` and `PAGURUS_PORT` when needed.

## Start it

```sh
# Terminal 1 — Runtime
npm run dev                 # or: CONCHBASE_PORT=4318 node dist/cli.js serve

# Terminal 2 — Console
cd pagurus && npm install && npm run dev
```

Health check: `curl -s http://127.0.0.1:${PORT}/v1/health`, where `PORT` is the
number the session banner printed at startup (4318 only in the original
checkout).
Preflight: `conchbase diagnose` checks Node, paths, port, gateway, and console
in one pass.

## Fake provider instead of Magpie

Unit and paired tests use in-process fake providers (`tests/agent-paired-runtime.test.ts`
and the `fetch` stubs in each focused test). The live eval harness
(`npm run eval`) is the only path that needs a real gateway; it is not part of
`npm test`.

## Common failures

| Symptom | Cause | Fix |
|---|---|---|
| `Node.js … is too old` | wrong interpreter | `nvm use` |
| `EADDRINUSE :<port>` | a Runtime is already running on that port | stop it, or use a linked worktree (gets its own port) |
| `Runtime database is already owned` | two processes on one SQLite file | one Runtime per database path |
| Console shows offline | Runtime not up, or port mismatch | check `/v1/health`; set `CONCHBASE_URL` |
| Task stuck in `waiting_approval` | a write tool needs approval | approve via the conversation's shown `POST …/approval` hint |
| Model errors / empty reply | no gateway, or unknown model | `conchbase models`; set `CONCHBASE_MODEL` |

## Checks

Runtime: `npm run check && npm test && npm run build`.
Console: `cd pagurus && npm run check && npm test && npm run build`.
When a change touches both, run both sets.
