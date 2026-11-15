# Decision 0078: Parallel worktree development

Status: **accepted and implemented parallel-session isolation**

Date: 2026-11-15 (Asia/Shanghai).

## Context

Several Codex sessions now work on this repository at once, each on its own
branch. Git itself is not the obstacle: `git worktree add` produces an isolated
checkout and branch, and a fresh `npm ci` against a warm cache takes about a
second. The obstacle was that everything *around* the checkout assumed one
instance existed.

Measured in a linked worktree:

1. `npm run dev` failed with `EADDRINUSE` because the port was hard-coded to
   4318, which the main checkout already held.
2. `pagurus/vite.config.ts` proxied `/v1` to `127.0.0.1:4318` literally, so a
   parallel console silently read the **main checkout's Runtime** while
   displaying its own branch's UI. That is worse than a crash: it shows stale
   behaviour as if it were the change under test.
3. The default database path was `.conchbase/runtime.sqlite` under each
   checkout, which happens to be isolated by the worktree itself, but the path
   gave no indication of which session a file belonged to.
4. ADR numbers were assigned by "read the highest, add one". Two sessions
   writing concurrently reserve the same number, and the collision surfaces at
   merge time when both files already exist.

## Decision

1. `scripts/worktree-env.mjs` derives a session identity from the checkout.
   The **main** working tree keeps port `4318`, `.conchbase/runtime.sqlite`, and
   the repository root as its workspace. A **linked** worktree gets a stable
   port in `4320–4399` hashed from its branch slug, a database under
   `.conchbase/<slug>/runtime.sqlite`, and a workspace under
   `.conchbase/<slug>/workspace`.
2. `scripts/dev.mjs` uses that derivation for `CONCHBASE_PORT`,
   `CONCHBASE_DB`, and `CONCHBASE_WORKSPACE_ROOT`, and prints the resolved
   session, bind address, database, and workspace before it binds. An explicit
   environment variable still wins, so a human can always override.
3. `pagurus/vite.config.ts` derives its proxy target the same way and adds a
   console port offset, so a parallel console talks to **its own** Runtime. An
   explicit `CONCHBASE_URL` still wins.
4. The default runtime URL remains `http://127.0.0.1:4318` for the main
   checkout, so every existing document, guardrail, and habit stays valid.
5. `scripts/next-adr.mjs` reserves an ADR number by creating the file with an
   exclusive open. A lost race increments and retries instead of producing a
   duplicate number.
6. Isolation stays loopback-only. The change adds no new network surface and no
   authentication requirement.

## Options

### A. Assign ports manually per session

Consequences: the assignment lives in someone's head, and the failure mode is a
crash at startup that a fresh session will not diagnose. Rejected.

### B. Run one shared Runtime for all sessions

Consequences: sessions would share database rows and overwrite each other's
organization state, and a `Task` owner would be ambiguous. Rejected.

### C. Derive everything from the checkout, deterministically, with override

Consequences: no coordination is needed to start a session, the main checkout is
unchanged, and a human can still force a value. Accepted.

## Validation

- `main` resolves to `port 4318`, `.conchbase/runtime.sqlite`, and the
  repository root; a linked worktree on `trial/iso-check` resolves to `port
  4345`, `.conchbase/trial-iso-check/runtime.sqlite`, and its own workspace.
- `pagurus` guardrails assert the proxy target is derived, still defaults to
  loopback `4318`, and never configures a non-loopback target.
- `node scripts/next-adr.mjs "…"` reserved `0078` without a collision and will
  increment if the number is already taken.
- `npm run check`, `npm test`, and `npm run build` pass in both repositories.

## Consequences

A session can be started with `git worktree add`, `npm ci`, and `npm run dev`,
with no coordination and no shared state. The main checkout behaves exactly as
before.

What this does **not** solve: the entry documents (`docs/PROJECT_STATUS.json`,
`docs/AI_TASK_QUEUE.md`, `README.md`) are still single files that every session
edits, so parallel branches will conflict there. That is a documentation-merge
problem, tracked separately in ADR 0079 rather than hidden inside this one.
