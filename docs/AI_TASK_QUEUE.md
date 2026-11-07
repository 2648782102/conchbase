# AI task queue

This queue is for coding models continuing from the repository. It records bounded work that can be started without another chat. It is not a release plan and does not imply approval of the proposed public contracts.

## Current state

- Both repositories are scaffold repositories whose pushed heads have green `npm run check`, `npm test`, and `npm run build`; this queue reflects the pushed internal acceptance slice.
- Conchbase exposes only `GET /v1/health` and `GET /v1/runtime`; see `docs/API.md` and `docs/openapi.yaml`.
- Conchbase has deterministic, **internal-only** modules and tests for task transitions, event ordering, configuration revisions, a tool policy gate, and provider-independent fake-model terminal paths. They are not wired into HTTP; fixture model/tool callbacks do not call real providers or execute real tools.
- A dependency-free OpenAPI contract test treats `docs/openapi.yaml` as the source of truth for the current read-only response fixtures. It does not implement a general generated validator.
- Pagurus is a read-only status client with an explicit unsupported-API-version state and tests. It must not invent a second API schema.
- `main` is protected against force pushes and deletion by an active GitHub ruleset; normal pushes remain allowed.

## Before locking any public contract

The following proposals in `docs/decisions/` require explicit product direction:

- `0002-task-lifecycle-proposal.md`: states, cancellation, retry/failure details, and task IDs.
- `0003-event-ordering-proposal.md`: SSE envelope, cursor mapping, retention, durable transactions, and multi-process ownership.
- `0004-configuration-revision-proposal.md`: profile schema, validation errors, migrations, rollback, secret references, and display ordinals.

Do not add write routes, generate client types, or build configuration forms from these internal shapes before their owning ADR is accepted.

## Task status

### Done in the current internal acceptance slice

1. **Provider-independent acceptance tests.** `src/runtime/model-adapter.ts`, `src/runtime/task-runner.ts`, and `tests/task-runner.test.ts` define an internal fake adapter and prove success, failure, and cancellation terminal paths without a later tool execution. There is no provider SDK, network call, or new endpoint.
2. **Policy fixtures.** `tests/policy-gate.test.ts` and `tests/fixtures/runtime-fixtures.ts` cover denied-tool, approval-required, approval-revoked, and approved-after-grant scenarios. Fake secret markers are asserted absent from event/log-shaped fixtures.
3. **API contract test tooling.** `tests/openapi-contract.test.ts` reads `docs/openapi.yaml` without a new dependency, checks current route/schema fields, compares exact response fixtures, and injects the live read-only routes. `docs/openapi.yaml` remains the source of truth.

### Done in Pagurus

5. **Pagurus incompatibility state.** The shipped Pagurus scaffold has an explicit unsupported-API-version state, recovery guidance, and API/component tests. It is a client-side guard against the current `/v1/health` version, not a negotiated versioning protocol. Do not repeat this work or treat it as approval of new API shapes.

### Next independent task

4. **Storage compatibility spike.** In a scratch branch, exercise candidate SQLite drivers on Node 24 with a tiny transaction test and record results in a new proposal ADR. Do not introduce the driver into runtime code yet. Keep this separate from the current Conchbase `main` slice.

### Blocked

6. **Pagurus accessibility pass.** Wait for a real write form before adding deterministic keyboard-focus, 320px layout, and reduced-motion CSS tests; do not convert navigation placeholders into fake workflows.

The three proposal ADRs above remain **product-direction blocked**. Their public task, event, and configuration contracts must not be implemented, generated into clients, or exposed as write routes until accepted.

## Definition of done for each task

- Read `AGENTS.md`, `docs/AI_HANDOFF.md`, `docs/AI_DEVELOPMENT.md`, and the owning architecture/API document first.
- Keep implemented behavior separate from planned behavior in every doc/README update.
- Add or update deterministic tests; never use real credentials, personal data, or public-network dependencies.
- Run `npm run check`, `npm test`, and `npm run build` in the affected repository.
- If a public API or shared schema would change, write an ADR with options/consequences/recommendation and request product direction before implementing it.
- Commit the focused slice, report changed files and validation results, and update this queue.
