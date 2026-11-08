# AI task queue

This queue is for coding models continuing from the repository. It records bounded work and current repository facts. It is not a release plan and does not accept new public contracts.

## Current state

- [ADR 0010](decisions/0010-first-real-model-slice.md) accepts phase-1 direction: Conchbase owns the agent loop, Magpie is the first real-model provider, and durable events plus explicit retry cover interruption. A process restart recognizes interrupted work; it does not continue an in-flight model request.
- [ADR 0011](decisions/0011-phase-one-database-instance-ownership.md) accepts an internal single-owner database boundary. The SQLite store rejects a second simultaneous owner; `conchbase models` is database-free. Cross-platform crash recovery, migrations, and deliberate multi-process execution remain open.
- [ADR 0012](decisions/0012-streaming-output-progress.md) accepts durable `task.output_delta` events, `partialOutput`, and bounded Magpie streaming. SSE, `Last-Event-ID`, retention, reasoning display, and streaming tool calls remain open.
- [ADR 0013](decisions/0013-bounded-tool-capability-kernel.md) accepts an internal, fixture-only tool registry, exact versioned approval records, per-attempt idempotency, bounded audit scalars, and replayable normalized failures. It changes no public route, tool-prefixed event names remain internal test vocabulary, and model-driven and real host tool execution remain blocked.
- [ADR 0014](decisions/0014-versioned-configuration-api.md) accepts the `0.4.0` configuration document contract, durable immutable revision history, validation, apply, and rollback. It changes no composition or capability lifecycle; references remain opaque data.
- [ADR 0015](decisions/0015-composition-identity-kernel.md) accepts an internal, topology-neutral composition validator and `cmp_` identity, and records that composition execution identity precedes public tool execution. It changes no public contract.
- Conchbase exposes versioned task, retry, cancel, event, Magpie model-catalog, and configuration-revision routes. Pagurus and other external clients use the Runtime API; phase-1 CLI task-state and configuration reads take short-lived private database ownership. The OpenAPI contract is the source of truth.
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

1. **Composition execution and public schema slice.** Accept a new configuration schema version with a topology-neutral composition section, task/event identity, cancellation propagation, and deterministic single-node plus two distinct multi-node fixtures. Run bounded composition execution first without model-driven or real tool execution. Do not hardcode layer counts, role names, or a hierarchy.
2. **Public tool contract slice.** Decide provider tool-call parsing, approval endpoints, durable audit storage, crash-safe side effects, and real executor isolation before wiring `ToolCapabilityKernel` to the Runtime API. Approval records and audit events must include composition node identity and the pinned configuration revision. A Skill never grants tools.
3. **Configuration lifecycle slice.** Add an accepted portable file format, import/export, migrations, secret resolution, Skill/plugin/MCP bundle schemas, and separate install/enable/grant operations. The current revision document is data only.
4. **Persistence hardening.** Add supported OS/architecture/Node CI coverage, migrations, WAL crash recovery, retention, and multi-process ownership before calling the storage layer production-ready.
5. **Magpie upstream adapter.** Once the Conchbase config format is stable, evaluate a pull request to Magpie's `internal/agent` so Conchbase appears on its Agents page. This is optional integration work, not required for the gateway.
6. **Authoritative client reads.** Replace direct CLI database reads with a documented Runtime API client path after API parity and authentication direction are accepted. Keep the single-owner lock until that contract exists.
7. **SSE compatibility.** Only after `Last-Event-ID`, retention, and reconnect semantics are accepted, decide whether to expose the durable event log over SSE in addition to polling.

## Blocked until direction

- Generated client types built from an unaccepted schema, portable configuration files, secret resolution, Skill/plugin/MCP installers, and capability grants.
- Model-driven tool execution, tool/approval HTTP routes, real host tools, MCP servers, Skills granting tools, arbitrary plugin loading, and durable tool audit storage.
- Automatic continuation of in-flight model or tool work after a crash.
- Running task-state CLI commands concurrently with `conchbase serve`, or treating SQLite exclusive locking as multi-process support.
- MCP process lifecycle, per-tool grants, arbitrary plugin loading, remote binding, authentication/pairing, and desktop packaging.
- Pagurus configuration forms that present one topology as the only supported shape, or that add composition editing before Conchbase accepts the public schema.

Do not weaken or delete the repository guardrails to bypass this queue. Update them only in the same slice as an accepted ADR or a documented development-boundary change.

## Definition of done for each task

- Read `AGENTS.md`, `docs/AI_HANDOFF.md`, `docs/AI_DEVELOPMENT.md`, ADRs `0010`–`0015`, and the owning architecture/API document first.
- Keep implemented behavior separate from planned behavior in every doc/README update.
- Add deterministic tests; never use real credentials, personal data, public-network dependencies, or user runtime data in fixtures.
- Run `npm run check`, `npm test`, and `npm run build` in the affected repository.
- If a public API or shared schema changes, write an ADR with options/consequences/recommendation and record direction before implementing it.
- Commit the focused slice, report changed files and validation results, and update this queue.
