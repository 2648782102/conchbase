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
- [ADR 0017](decisions/0017-public-tool-request-approval-ledger.md) accepts the `0.6.0` public tool request/approval ledger: three routes, durable normalized requests and approvals, composition-scoped idempotency, durable request/decision audit events, and no tool execution.
- Conchbase exposes versioned task, retry, cancel, event, Magpie model-catalog, and configuration-revision routes. Pagurus and other external clients use the Runtime API; phase-1 CLI task-state and configuration reads take short-lived private database ownership. The OpenAPI contract is the source of truth.
- The phase-1 model loop is single-turn for `schemaVersion: 1`. The deterministic composition loop is bounded for `schemaVersion: 2`. Neither is a default or canonical agent topology. User-defined composition remains topology-neutral product intent.
- `node:sqlite` persists tasks, events, and configuration revisions behind `TaskStore`. Provider calls use direct HTTP through a narrow adapter. No provider SDK, storage SDK, MCP SDK, or plugin host is installed.
- `tests/repository-guardrails.test.ts` checks AI-first entry documents, accepted ADR status, the exact `0.6.0` OpenAPI path set and version, loopback-only configuration, source boundaries, dependency boundaries, and the public ledger's no-execution rules. It was updated in the same slice as ADR `0017`.
- Both repositories have protected `main` rulesets against force pushes and deletion; normal pushes remain allowed.

## Done in the composition execution slice

1. **Accepted direction.** ADR `0016` records the versioned public schema, deterministic execution boundary, event identity, cancellation, and explicit non-goals.
2. **Versioned configuration.** `ConfigurationDocument` accepts `schemaVersion: 1` and `schemaVersion: 2` without reinterpreting v1. v2 requires a topology-neutral composition section; revision ids use versioned hash prefixes.
3. **Deterministic executor.** `composition-execution.ts` computes `cmp_` identity, topological node order, terminal ids, and bounded output. `TaskService` dispatches v2 tasks without a model call or tool execution.
4. **Durable events.** Composition events carry the pinned configuration revision, attempt, `compositionDocumentId`, and node identity in the existing event `data` envelope. Cancellation records a node-cancelled event and stops later nodes.
5. **AI handoff.** Entry documents, README files, architecture, API, technology, roadmap, validation, and workspace notes distinguish implemented composition execution from planned model-driven tool work.

## Done in the public tool request/approval ledger slice

1. **Accepted direction.** ADR `0017` records the versioned public ledger, provider-neutral tool call proposal, composition-scoped identity, durable approvals and audit events, and explicit no-execution boundary.
2. **Versioned API.** OpenAPI `0.6.0` adds `POST /v1/tool-requests`, `GET /v1/tool-requests/{requestId}`, and `POST /v1/tool-requests/{requestId}/approval`. No execution, listing, registration, MCP, Skill, plugin, secret, or generated-client route exists.
3. **Durable ledger.** A private `tool_requests` table stores normalized request identity, status, approval decision, and digest-only reason. Request creation and decisions commit with their durable events in one transaction.
4. **AI handoff.** Entry documents, README files, architecture, API, technology, roadmap, validation, and workspace notes distinguish the ledger from tool execution and from the internal fixture-only kernel.

## Next bounded slices

Each item requires an accepted ADR before its public contract changes. Do not start several at once.

1. **Provider tool-call parsing and execution boundary.** Decide how a provider's structured tool call becomes the accepted normalized proposal, then separately decide durable execution results, crash-safe side effects, real executor isolation, per-tool grants, and whether `ToolCapabilityKernel` is replaced or migrated. A ledger approval must not be treated as execution permission. This is the first next slice.
2. **Pagurus tool approval client.** Only after its own accepted client ADR, add explicit pending/approved/rejected states, exact requested-action display, keyboard access, and capability handling through Conchbase's published routes. Never read private runtime state.
3. **Configuration lifecycle slice.** Add an accepted portable file format, import/export, migrations, secret resolution, Skill/plugin/MCP bundle schemas, and separate install/enable/grant operations. The current revision document is data only.
4. **Persistence hardening.** Add supported OS/architecture/Node CI coverage, migrations, WAL crash recovery, retention, and multi-process ownership before calling the storage layer production-ready.
5. **Magpie upstream adapter.** Once the Conchbase config format is stable, evaluate a pull request to Magpie's `internal/agent` so Conchbase appears on its Agents page. This is optional integration work, not required for the gateway.
6. **Authoritative client reads.** Replace direct CLI database reads with a documented Runtime API client path after API parity and authentication direction are accepted. Keep the single-owner lock until that contract exists.
7. **SSE compatibility.** Only after `Last-Event-ID`, retention, and reconnect semantics are accepted, decide whether to expose the durable event log over SSE in addition to polling.

## Blocked until direction

- Generated client types built from an unaccepted schema, portable configuration files, secret resolution, Skill/plugin/MCP installers, and capability grants.
- Model-driven tool execution, public tool execution routes, real host tools, MCP servers, Skills granting tools, arbitrary plugin loading, crash-safe side effects, real executor isolation, and provider tool-call parsing.
- Model-driven composition nodes, delegation, concurrency, general scheduling, role registries, cyclic coordination, and automatic continuation of in-flight model or tool work after a crash.
- Running task-state CLI commands concurrently with `conchbase serve`, or treating SQLite exclusive locking as multi-process support.
- MCP process lifecycle, per-tool grants, arbitrary plugin loading, remote binding, authentication/pairing, and desktop packaging.
- Pagurus composition forms that present one topology as the only supported shape, or that add a visual builder before its own accepted ADR.

Do not weaken or delete the repository guardrails to bypass this queue. Update them only in the same slice as an accepted ADR or a documented development-boundary change.

## Definition of done for each task

- Read `AGENTS.md`, `docs/AI_HANDOFF.md`, `docs/AI_DEVELOPMENT.md`, ADRs `0010`–`0017`, and the owning architecture/API document first.
- Keep implemented behavior separate from planned behavior in every doc/README update.
- Add deterministic tests; never use real credentials, personal data, public-network dependencies, or user runtime data in fixtures.
- Run `npm run check`, `npm test`, and `npm run build` in the affected repository.
- If a public API or shared schema changes, write an ADR with options/consequences/recommendation and record direction before implementing it.
- Commit the focused slice, report changed files and validation results, and update this queue.
