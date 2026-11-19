# Conchbase coding notes

Conchbase is the runtime for a personal Agent product. It owns model calls,
Agent identity and revisions, task state, conversations, tools, permissions,
durable events, and local persistence. Pagurus and the CLI are clients.

## Start here

Read `docs/START_HERE.md`. It is the short, current guide for coding models.
Then read `docs/PROJECT_PLAN.md` and the task-specific files named by that
plan. Do not search for additional process documents before starting work.

## Product shape

- Build for one person using a local runtime first.
- Prefer a complete, understandable personal assistant over a generic
  enterprise platform.
- Keep the runtime authoritative. Clients must not read the private database
  or implement a competing task, conversation, Agent, or permission model.
- Keep provider details behind adapters. Magpie is the current compatibility
  path, not the product identity.
- Every model- or tool-supplied value is untrusted input. Validate, bound, and
  normalize it before it changes durable state or reaches another boundary.

## Security essentials

- Never put plaintext credentials in prompts, model messages, durable events,
  logs, errors, client responses, browser state, or Agent definitions.
- Never execute a tool without an explicit Runtime-owned capability decision.
- Keep filesystem, subprocess, network, and external-write tools narrow,
  bounded, observable, and disabled by default until their safety behavior is
  covered by tests.
- Bind local development to loopback by default. Treat remote access as a
  separate product feature, not a quick configuration toggle.

## Implementation habits

- Make small vertical slices: contract, runtime, client, tests, docs.
- Put validation at boundaries and keep domain logic independent of Fastify.
- Preserve existing behavior unless the task explicitly changes it.
- Prefer the smallest dependency that solves the problem.
- Before editing, inspect `git status` and the owning modules. Do not erase
  unrelated user work.
- Update `docs/CURRENT_STATE.md` or `docs/PROJECT_PLAN.md` when behavior changes.

## Verification

Use Node.js 24 or newer. For runtime changes, normally run:

```sh
npm run check
npm test
npm run build
```

For documentation-only changes, run the focused documentation/guardrail test
if dependencies are installed, then report that the full suite was not run.
Never claim a check passed without running it.
