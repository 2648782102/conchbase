# AI task queue

This queue is for coding models continuing from the repository. It records bounded work and current repository facts. It is not a release plan and does not accept new public contracts.

## Current state

- [ADR 0010](decisions/0010-first-real-model-slice.md) accepts phase-1 direction: Conchbase owns the agent loop, Magpie is the first real-model provider, and durable events plus explicit retry cover interruption. A process restart recognizes interrupted work; it does not continue an in-flight model request.
- [ADR 0011](decisions/0011-phase-one-database-instance-ownership.md) accepts an internal single-owner database boundary. The SQLite store rejects a second simultaneous owner; `conchbase models` is database-free. Cross-platform crash recovery, migrations, and deliberate multi-process execution remain open.
- [ADR 0012](decisions/0012-streaming-output-progress.md) accepts durable `task.output_delta` events, `partialOutput`, and bounded Magpie streaming. SSE, `Last-Event-ID`, retention, reasoning display, and streaming tool calls remain open.
- [ADR 0013](decisions/0013-bounded-tool-capability-kernel.md) accepts an internal, fixture-only tool registry, exact versioned approval records, per-attempt idempotency, bounded audit scalars, and replayable normalized failures. It changes no public route, tool-prefixed event names remain internal test vocabulary, and model-driven and real host tool execution remain blocked.
- [ADR 0014](decisions/0014-versioned-configuration-api.md) accepts the `0.4.0` `schemaVersion: 1` configuration document, durable immutable revision history, validation, apply, and rollback. References remain opaque data.
- [ADR 0015](decisions/0015-composition-identity-kernel.md) accepts an internal, topology-neutral composition validator and `cmp_` identity, and records that composition execution identity precedes public tool execution.
- [ADR 0016](decisions/0016-composition-execution-and-public-schema.md) accepts the `0.5.0` v1/v2 configuration union, a public topology-neutral composition section, deterministic node-order execution, composition node event identity, cancellation propagation, and single-node plus distinct multi-node fixtures. It makes no model call, executes no tool, and adds no route.
- Conchbase exposes versioned task, retry, cancel, event, Magpie model-catalog, and configuration-revision routes. Pagurus and other external clients use the Runtime API; phase-1 CLI task-state and configuration reads take short-lived private database ownership. The OpenAPI contract is the source of truth.
- The phase-1 model loop is single-turn for `schemaVersion: 1`. The deterministic composition loop is bounded for `schemaVersion: 2`. Neither is a default or canonical agent topology. User-defined composition remains topology-neutral product intent.
- `node:sqlite` persists tasks, events, and configuration revisions behind `TaskStore`. Provider calls use direct HTTP through a narrow adapter. No provider SDK, storage SDK, MCP SDK, or plugin host is installed.
- `tests/repository-guardrails.test.ts` checks AI-first entry documents, accepted ADR status, the exact OpenAPI path set and version, loopback-only configuration, source boundaries, and dependency boundaries. It was updated in the same slice as ADR `0016`.
- Both repositories have protected `main` rulesets against force pushes and deletion; normal pushes remain allowed.

## Done in the composition execution slice

1. **Accepted direction.** ADR `0016` records the versioned public schema, deterministic execution boundary, event identity, cancellation, and explicit non-goals.
2. **Versioned configuration.** `ConfigurationDocument` accepts `schemaVersion: 1` and `schemaVersion: 2` without reinterpreting v1. v2 requires a topology-neutral composition section; revision ids use versioned hash prefixes.
3. **Deterministic executor.** `composition-execution.ts` computes `cmp_` identity, topological node order, terminal ids, and bounded output. `TaskService` dispatches v2 tasks without a model call or tool execution.
4. **Durable events.** Composition events carry the pinned configuration revision, attempt, `compositionDocumentId`, and node identity in the existing event `data` envelope. Cancellation records a node-cancelled event and stops later nodes.
5. **AI handoff.** Entry documents, README files, architecture, API, technology, roadmap, validation, and workspace notes distinguish implemented composition execution from planned model-driven tool work.

## Next bounded slices

Each item requires an accepted ADR before its public contract changes. Do not start several at once.

1. **Public tool contract slice.** Decide provider tool-call parsing, approval endpoints, durable audit storage, crash-safe side effects, and real executor isolation before wiring `ToolCapabilityKernel` to the Runtime API. Approval records, idempotency keys, and audit events must include `configurationRevisionId`, `compositionDocumentId`, `compositionNodeId`, and attempt. A Skill never grants tools. This is the first next slice.
2. **Configuration lifecycle slice.** Add an accepted portable file format, import/export, migrations, secret resolution, Skill/plugin/MCP bundle schemas, and separate install/enable/grant operations. The current revision document is data only.
3. **Persistence hardening.** Add supported OS/architecture/Node CI coverage, migrations, WAL crash recovery, retention, and multi-process ownership before calling the storage layer production-ready.
4. **Magpie upstream adapter.** Once the Conchbase config format is stable, evaluate a pull request to Magpie's `internal/agent` so Conchbase appears on its Agents page. This is optional integration work, not required for the gateway.
5. **Authoritative client reads.** Replace direct CLI database reads with a documented Runtime API client path after API parity and authentication direction are accepted. Keep the single-owner lock until that contract exists.
6. **SSE compatibility.** Only after `Last-Event-ID`, retention, and reconnect semantics are accepted, decide whether to expose the durable event log over SSE in addition to polling.

## Blocked until direction

- Generated client types built from an unaccepted schema, portable configuration files, secret resolution, Skill/plugin/MCP installers, and capability grants.
- Model-driven tool execution, tool/approval HTTP routes, real host tools, MCP servers, Skills granting tools, arbitrary plugin loading, and durable tool audit storage.
- Model-driven composition nodes, delegation, concurrency, general scheduling, role registries, cyclic coordination, and automatic continuation of in-flight model or tool work after a crash.
- Running task-state CLI commands concurrently with `conchbase serve`, or treating SQLite exclusive locking as multi-process support.
- MCP process lifecycle, per-tool grants, arbitrary plugin loading, remote binding, authentication/pairing, and desktop packaging.
- Pagurus composition forms that present one topology as the only supported shape, or that add a visual builder before its own accepted ADR.

Do not weaken or delete the repository guardrails to bypass this queue. Update them only in the same slice as an accepted ADR or a documented development-boundary change.

## Definition of done for each task

- Read `AGENTS.md`, `docs/AI_HANDOFF.md`, `docs/AI_DEVELOPMENT.md`, ADRs `0010`–`0016`, and the owning architecture/API document first.
- Keep implemented behavior separate from planned behavior in every doc/README update.
- Add deterministic tests; never use real credentials, personal data, public-network dependencies, or user runtime data in fixtures.
- Run `npm run check`, `npm test`, and `npm run build` in the affected repository.
- If a public API or shared schema changes, write an ADR with options/consequences/recommendation and record direction before implementing it.
- Commit the focused slice, report changed files and validation results, and update this queue.
