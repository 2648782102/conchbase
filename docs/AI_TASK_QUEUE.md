# AI task queue

This queue is for coding models continuing from the repository. It records bounded work and current repository facts. It is not a release plan and does not accept new public contracts.

## Current state

- [ADR 0010](decisions/0010-first-real-model-slice.md) accepts phase-1 direction: Conchbase owns the agent loop, Magpie is the first real-model provider, and durable events plus explicit retry cover interruption. A process restart recognizes interrupted work; it does not continue an in-flight model request.
- [ADR 0011](decisions/0011-phase-one-database-instance-ownership.md) accepts an internal single-owner database boundary. The SQLite store rejects a second simultaneous owner; `conchbase models` is database-free. Cross-platform crash recovery, migrations, and deliberate multi-process execution remain open.
- Conchbase exposes versioned task, retry, cancel, event, and Magpie model-catalog routes. The CLI and Pagurus use the same API. The OpenAPI contract is the source of truth.
- The phase-1 model loop is single-turn. This is an implementation boundary for validating the runtime, not a default or canonical agent topology. User-defined composition remains topology-neutral product intent, not an implemented schema.
- `node:sqlite` persists tasks and events behind `TaskStore`. Provider calls use direct HTTP through a narrow adapter. No provider SDK, storage SDK, MCP SDK, or plugin host is installed.
- `tests/repository-guardrails.test.ts` checks AI-first entry documents, accepted ADR status, the phase-1 OpenAPI path set, loopback-only configuration, source boundaries, and dependency boundaries. It was updated in the same slice as ADR `0010`.
- Both repositories have protected `main` rulesets against force pushes and deletion; normal pushes remain allowed.

## Done in the phase-1 slice

1. **Accepted direction.** ADR `0010` records the final boundary, Magpie evidence, explicit retry rationale, and non-goals. Proposal ADRs `0002`–`0008` keep their broader open questions.
2. **Provider adapter.** `src/runtime/magpie-provider.ts` parses a local OpenAI Chat Completions response, rejects tool calls, forwards cancellation, and normalizes errors. Tests use fake `fetch`.
3. **Durable state.** `src/runtime/task-store.ts` atomically writes task transitions and events to SQLite; `src/runtime/task-service.ts` handles completion, failures, cancellation, restart interruption, and retry.
4. **API and CLI.** `docs/openapi.yaml`, `src/http/routes/v1/`, `src/cli.ts`, and `src/main.ts` provide local clients with one contract. Pagurus uses the same routes.
5. **AI handoff.** Entry documents, README files, architecture, API, technology, roadmap, validation, and workspace notes distinguish implemented phase-1 behavior from planned work.

## Next bounded slices

Each item requires an accepted ADR before its public contract changes. Do not start several at once.

1. **Provider streaming and visible progress.** Decide the event envelope for partial model output, cancellation during streaming, and terminal output. Keep event IDs and task state authoritative.
2. **Tool capability slice.** Define one bounded tool registry, a policy schema, approval records, idempotent side effects, and deterministic fixtures before any model-requested tool can execute. A Skill never grants tools.
3. **Configuration API slice.** Define a portable, versioned profile schema, validation errors, revision history, rollback, and secret references. Then let Pagurus edit it through the Runtime API.
4. **Composition slice.** Define topology-neutral user-authored composition with at least one single-node and two distinct multi-node fixtures. Do not hardcode layer counts, role names, or a hierarchy.
5. **Persistence hardening.** Add supported OS/architecture/Node CI coverage, migrations, WAL crash recovery, retention, and multi-process ownership before calling the storage layer production-ready.
6. **Magpie upstream adapter.** Once the Conchbase config format is stable, evaluate a pull request to Magpie's `internal/agent` so Conchbase appears on its Agents page. This is optional integration work, not required for the gateway.
7. **Authoritative client reads.** Replace direct CLI database reads with a documented Runtime API client path after API parity and authentication direction are accepted. Keep the single-owner lock until that contract exists.

## Blocked until direction

- Configuration write routes and generated client types built from an unaccepted schema.
- Automatic continuation of in-flight model or tool work after a crash.
- Running task-state CLI commands concurrently with `conchbase serve`, or treating SQLite exclusive locking as multi-process support.
- MCP process lifecycle, per-tool grants, arbitrary plugin loading, remote binding, authentication/pairing, and desktop packaging.
- Pagurus configuration forms that present one topology as the only supported shape.

Do not weaken or delete the repository guardrails to bypass this queue. Update them only in the same slice as an accepted ADR or a documented development-boundary change.

## Definition of done for each task

- Read `AGENTS.md`, `docs/AI_HANDOFF.md`, `docs/AI_DEVELOPMENT.md`, ADRs `0010`–`0011`, and the owning architecture/API document first.
- Keep implemented behavior separate from planned behavior in every doc/README update.
- Add deterministic tests; never use real credentials, personal data, public-network dependencies, or user runtime data in fixtures.
- Run `npm run check`, `npm test`, and `npm run build` in the affected repository.
- If a public API or shared schema changes, write an ADR with options/consequences/recommendation and record direction before implementing it.
- Commit the focused slice, report changed files and validation results, and update this queue.
