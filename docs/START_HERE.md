# Conchbase: start here

Conchbase is a local-first personal Agent runtime. It is not a hosted
multi-tenant platform. The goal is a reliable assistant that can converse,
remember useful facts, use carefully bounded tools, and show the user what it
did.

## Read only these first

1. This file.
2. [`CURRENT_STATE.md`](CURRENT_STATE.md) — what exists today and what is
   missing.
3. [`PROJECT_PLAN.md`](PROJECT_PLAN.md) — the ordered product plan and the
   next executable tasks.

Read [`DEVELOPMENT.md`](DEVELOPMENT.md) before changing code. When a task
touches both repositories, also read
[`PAIRED_DEVELOPMENT.md`](PAIRED_DEVELOPMENT.md) for ports, startup order, and
shared failures. Read
[`ARCHITECTURE.md`](ARCHITECTURE.md) only for the subsystem you touch. Read
`docs/openapi.yaml` when changing an HTTP contract. Do not search for
additional process documents before starting work.

## Product in one paragraph

The user talks to a primary Boss conversation or a selected Agent. Conchbase
turns that input into model calls, bounded tool calls, durable state, and
human-readable progress. Pagurus is an optional UI; the CLI and future clients
use the same Runtime API. The Runtime is the only authority for permissions,
task lifecycle, Agent revisions, and external effects.

## Current development priority

Make the existing local product dependable before adding more surface area:

1. reproducible Node 24 setup and baseline checks;
2. persistence, restart, cancellation, and event correctness;
3. a clean provider adapter interface and useful model errors;
4. safe built-in tools with clear approvals and evidence;
5. a simpler Pagurus user journey;
6. packaging, backups, diagnostics, and optional integrations.

Do not start a new integration because it is interesting. Finish the next
smallest end-to-end slice in `PROJECT_PLAN.md`.

## Task protocol for a coding model

1. Choose one task ID from the current phase.
2. Read its goal, files, acceptance checks, and dependencies.
3. Inspect the existing implementation before editing.
4. Write or update a focused test first when behavior changes.
5. Implement the smallest complete slice.
6. Run the task checks, then the normal runtime checks.
7. Update `CURRENT_STATE.md` or the plan if the behavior changed.
8. Report changed files, checks run, failures, and the next task.

## Non-negotiable safety rules

Plaintext secrets never enter model context, durable state, logs, errors,
browser state, or client responses. Tool execution always goes through Runtime
capabilities and approval policy. Model output is a proposal, never authority.
Filesystem and subprocess access stays inside explicit bounds. These rules
are product safety requirements, not a reason to preserve old document names
or old architecture when a better implementation is found.
