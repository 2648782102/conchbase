# AI task queue

This queue is for coding models continuing from the repository. It records bounded work that can be started without another chat. It is not a release plan and does not imply approval of the proposed public contracts.

## Current state

- Both repositories are scaffold repositories whose pushed heads have green `npm run check`, `npm test`, and `npm run build`; this queue reflects the pushed internal acceptance slice.
- Conchbase exposes only `GET /v1/health` and `GET /v1/runtime`; see `docs/API.md` and `docs/openapi.yaml`.
- Conchbase has deterministic, **internal-only** modules and tests for task transitions, event ordering, configuration revisions, a tool policy gate, and provider-independent fake-model terminal paths. They are not wired into HTTP; fixture model/tool callbacks do not call real providers or execute real tools.
- A dependency-free OpenAPI contract test treats `docs/openapi.yaml` as the source of truth for the current read-only response fixtures. It does not implement a general generated validator.
- `docs/REFERENCE_PROJECTS.md` and ADRs `0005`–`0007` record dated external research, topology-neutral product intent, and proposed provider/configuration boundaries. ADR `0008` records a local SQLite driver compatibility spike. These are documentation only; no composition schema, provider adapter, plugin host, configuration route, or persistence driver is implemented.
- Pagurus is a read-only status client with an explicit unsupported-API-version state and tests. It must not invent a second API schema.
- `main` is protected against force pushes and deletion by an active GitHub ruleset; normal pushes remain allowed.

## Before locking any public contract

The following proposals in `docs/decisions/` require explicit product direction before any public contract is locked:

- `0002-task-lifecycle-proposal.md`: states, cancellation, retry/failure details, and task IDs.
- `0003-event-ordering-proposal.md`: SSE envelope, cursor mapping, retention, durable transactions, and multi-process ownership.
- `0004-configuration-revision-proposal.md`: profile schema, validation errors, migrations, rollback, secret references, and display ordinals.
- `0005-user-defined-agent-topology-proposal.md`: user-authored composition schema, identity, delegation, concurrency, cancellation propagation, and event shape. A layered multi-role arrangement is only an example; never hardcode it.
- `0006-provider-adapter-capability-boundary-proposal.md`: provider capability discovery, streaming, tool calls, cancellation, error semantics, credential references, and provider order.
- `0007-skill-plugin-mcp-configuration-proposal.md`: declarative bundle format, validation preview, MCP lifecycle/sandboxing, per-tool grants, plugin isolation, secret references, and rollback.
- `0008-sqlite-driver-compatibility-proposal.md`: production driver, persistence schema, normalized storage errors, migrations, WAL/crash recovery, and supported-platform CI matrix. This ADR records spike evidence; it does not propose a public API.

Do not add write routes, generate client types, build configuration forms, introduce a real provider SDK or storage driver, load plugin code, or hardcode a role hierarchy from these internal shapes before their owning ADR is accepted. A Skill never grants tool permissions.

## Product direction added in this slice

- **Accepted as intent only:** Conchbase should support highly customizable, user-defined agent composition. The composition must remain topology-neutral; no layer count, role name, hierarchy, coordination pattern, or single example becomes a built-in product shape.
- **Still blocked:** composition schema/API, provider SDK/conformance, Skill/plugin/MCP bundle format, and any Pagurus write form. See ADRs `0005`–`0007`.
- **Boundary preserved:** runtime owns task state, policy, approvals, events, and tool execution. Provider adapters and declarative extensions are replaceable inputs, not authorities.

## Task status

### Done in the current internal acceptance slice

1. **Provider-independent acceptance tests.** `src/runtime/model-adapter.ts`, `src/runtime/task-runner.ts`, and `tests/task-runner.test.ts` define an internal fake adapter and prove success, failure, and cancellation terminal paths without a later tool execution. There is no provider SDK, network call, or new endpoint.
2. **Policy fixtures.** `tests/policy-gate.test.ts` and `tests/fixtures/runtime-fixtures.ts` cover denied-tool, approval-required, approval-revoked, and approved-after-grant scenarios. Fake secret markers are asserted absent from event/log-shaped fixtures.
3. **API contract test tooling.** `tests/openapi-contract.test.ts` reads `docs/openapi.yaml` without a new dependency, checks current route/schema fields, compares exact response fixtures, and injects the live read-only routes. `docs/openapi.yaml` remains the source of truth.

### Done in Pagurus

5. **Pagurus incompatibility state.** The shipped Pagurus scaffold has an explicit unsupported-API-version state, recovery guidance, and API/component tests. It is a client-side guard against the current `/v1/health` version, not a negotiated versioning protocol. Do not repeat this work or treat it as approval of new API shapes.

### Done in the isolated storage spike

4. **Storage compatibility spike.** [ADR 0008](decisions/0008-sqlite-driver-compatibility-proposal.md) records a dated `darwin/arm64`, Node `v24.22.2` check of `node:sqlite`, `better-sqlite3@13.0.3`, and `sqlite3@6.0.1`. All three passed a temporary task/event transaction rollback, commit, and reopen fixture. The check ran outside the repository on a scratch branch; Conchbase runtime dependencies, source, lockfile, OpenAPI, and CI are unchanged. It is not cross-platform CI evidence and does not select a production driver.

### Blocked

6. **Pagurus accessibility pass.** Wait for a real write form before adding deterministic keyboard-focus, 320px layout, and reduced-motion CSS tests; do not convert navigation placeholders into fake workflows.
7. **Next implementation slice.** Wait for explicit product direction on the open ADRs, beginning with task lifecycle, event envelope, configuration revision, and user-authored composition. Do not add write routes, provider SDKs, a storage driver, client-generated types, or plugin loading to fill the queue.

Proposal ADRs `0002`–`0008` remain **product-direction blocked**. Their public task, event, composition, provider, configuration, and persistence contracts must not be implemented, generated into clients, or exposed as write routes until accepted.

## Definition of done for each task

- Read `AGENTS.md`, `docs/AI_HANDOFF.md`, `docs/AI_DEVELOPMENT.md`, and the owning architecture/API document first.
- Keep implemented behavior separate from planned behavior in every doc/README update.
- Add or update deterministic tests; never use real credentials, personal data, or public-network dependencies.
- Run `npm run check`, `npm test`, and `npm run build` in the affected repository.
- If a public API or shared schema would change, write an ADR with options/consequences/recommendation and request product direction before implementing it.
- Commit the focused slice, report changed files and validation results, and update this queue.
