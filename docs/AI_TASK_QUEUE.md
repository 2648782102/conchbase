# AI task queue

This queue is for coding models continuing from the repository. It records bounded work that can be started without another chat. It is not a release plan and does not imply approval of the proposed public contracts.

## Current state

- Both repositories are clean scaffolds with green `npm run check`, `npm test`, and `npm run build`.
- Conchbase exposes only `GET /v1/health` and `GET /v1/runtime`; see `docs/API.md` and `docs/openapi.yaml`.
- Conchbase has deterministic, **internal-only** modules and tests for task transitions, event ordering, configuration revisions, and a tool policy gate. They are not wired into HTTP and do not execute real tools.
- Pagurus is a read-only status client. It must not invent a second API schema.
- `main` is protected against force pushes and deletion by an active GitHub ruleset; normal pushes remain allowed.

## Before locking any public contract

The following proposals in `docs/decisions/` require explicit product direction:

- `0002-task-lifecycle-proposal.md`: states, cancellation, retry/failure details, and task IDs.
- `0003-event-ordering-proposal.md`: SSE envelope, cursor mapping, retention, durable transactions, and multi-process ownership.
- `0004-configuration-revision-proposal.md`: profile schema, validation errors, migrations, rollback, secret references, and display ordinals.

Do not add write routes, generate client types, or build configuration forms from these internal shapes before their owning ADR is accepted.

## Bounded next tasks

1. **Provider-independent acceptance tests.** Add a fake model adapter contract and transition tests that prove a failed/cancelled task reaches a terminal state without executing a later tool. No provider SDK, network call, or new endpoint.
2. **Policy fixtures.** Expand `tests/policy-gate.test.ts` with denied-tool, approval-required, and approval-revoked scenarios using deterministic local data; assert secrets never appear in event/log fixtures.
3. **API contract test tooling.** Add a local, dependency-free check that compares the exact read-only response fixtures with the documented JSON Schema shapes. Keep `docs/openapi.yaml` as the source of truth.
4. **Storage compatibility spike.** In a scratch branch, exercise candidate SQLite drivers on Node 24 with a tiny transaction test and record results in a new proposal ADR. Do not introduce the driver into runtime code yet.
5. **Pagurus incompatibility state.** Once Conchbase defines a version-negotiation behavior, implement the documented `incompatible` UI state, retry guidance, and component/API tests in the same vertical slice.
6. **Pagurus accessibility pass.** Add deterministic tests for keyboard focus, 320px layout assumptions, and reduced-motion CSS after there is a real write form; do not convert navigation placeholders into fake workflows.

## Definition of done for each task

- Read `AGENTS.md`, `docs/AI_HANDOFF.md`, `docs/AI_DEVELOPMENT.md`, and the owning architecture/API document first.
- Keep implemented behavior separate from planned behavior in every doc/README update.
- Add or update deterministic tests; never use real credentials, personal data, or public-network dependencies.
- Run `npm run check`, `npm test`, and `npm run build` in the affected repository.
- If a public API or shared schema would change, write an ADR with options/consequences/recommendation and request product direction before implementing it.
- Commit the focused slice, report changed files and validation results, and update this queue.
