# AI task queue

This queue is for coding models continuing from the repository. It records bounded work and current repository facts. It is not a release plan and does not accept new public contracts.

## Target-mode entry

The final local-first `1.0.0` target is closed. Read the machine-readable [project status](PROJECT_STATUS.json) and the Chinese [objective-mode brief](OBJECTIVE_MODE.zh-CN.md) before selecting a task from the historical sections below. [ADR 0026](decisions/0026-ai-handoff-readiness-development-boundary.md) accepts these artifacts as a development boundary only; English repository documents, `docs/openapi.yaml`, and accepted ADRs remain the source of truth.

Current state has three distinct record classes: `implemented`, `validationEvidence`, and `blockedDirections`. A completed walkthrough is validation evidence, not an executable fixture or an implemented feature. Every `blockedDirections` item has `requiresAcceptedAdr: true`; do not implement stable cross-process secrets, real external Sources, executable tools, production remote pairing, or generated clients by silently extending the frozen 47-path contract. In `nextBoundedSlices`, only `status: "ready"` with `requiresAcceptedAdr: false` is directly executable; `status: "proposal"` with `requiresAcceptedAdr: true` is gated on its named ADR.

ADR 0028 and Pagurus ADR 0014 close the executable interface-validation slice as credential-free provider compatibility, jsdom/CSS accessibility, and local published-contract fixtures. ADR 0029 closes the persistence test-boundary slice as abrupt-exit recovery, additive migration preservation, single-owner rejection, and portable reopen fixtures. Those fixtures are `validationEvidence`; they are not real-provider conformance, a real-browser accessibility audit, production storage hardening, or new product behavior. `nextBoundedSlices` is empty. ADR-gated product expansion remains listed below and must not be inferred from the exact order of this queue.

## Current state

- [ADR 0010](decisions/0010-first-real-model-slice.md) accepts phase-1 direction: Conchbase owns the agent loop and uses Magpie as the first compatibility implementation for real-model calls; this is not the product's sole provider or future Agent model contract. Durable events plus explicit retry cover interruption. A process restart recognizes interrupted work; it does not continue an in-flight model request.
- [ADR 0011](decisions/0011-phase-one-database-instance-ownership.md) accepts an internal single-owner database boundary. The SQLite store rejects a second simultaneous owner; `conchbase models` is database-free. Cross-platform crash recovery, migrations, and deliberate multi-process execution remain open.
- [ADR 0012](decisions/0012-streaming-output-progress.md) accepts durable `task.output_delta` events, `partialOutput`, and bounded streaming through the current Magpie compatibility adapter. SSE, `Last-Event-ID`, retention, reasoning display, and streaming tool calls remain open.
- [ADR 0013](decisions/0013-bounded-tool-capability-kernel.md) accepts an internal, fixture-only tool registry, exact versioned approval records, per-attempt idempotency, bounded audit scalars, and replayable normalized failures. It changes no public route, tool-prefixed event names remain internal test vocabulary, and model-driven and real host tool execution remain blocked.
- [ADR 0014](decisions/0014-versioned-configuration-api.md) accepts the `0.4.0` `schemaVersion: 1` configuration document, durable immutable revision history, validation, apply, and rollback. References remain opaque data.
- [ADR 0015](decisions/0015-composition-identity-kernel.md) accepts an internal, topology-neutral composition validator and `cmp_` identity, and records that composition execution identity precedes public tool execution.
- [ADR 0016](decisions/0016-composition-execution-and-public-schema.md) accepts the `0.5.0` v1/v2 configuration union, a public topology-neutral composition section, deterministic node-order execution, composition node event identity, cancellation propagation, and single-node plus distinct multi-node fixtures. It makes no model call, executes no tool, and adds no route.
- [ADR 0017](decisions/0017-public-tool-request-approval-ledger.md) accepts the `0.6.0` public tool request/approval ledger: three routes, durable normalized requests and approvals, composition-scoped idempotency, durable request/decision audit events, and no tool execution.
- [ADR 0018](decisions/0018-provider-tool-call-parsing-boundary.md) accepts an internal, pure parser for one OpenAI Chat Completions-compatible non-streaming function tool call, later wired by ADR 0019.
- [ADR 0019](decisions/0019-explicit-provider-tool-call-observation-boundary.md) accepts the `0.7.0` explicit provider observation boundary: one transient observation route, provider normalization, visible failure in the live v1 task path, no auto-ledger, and no execution.
- ADR 0020 and Runtime API 1.0.0 implement runtime-local Agent resources/revisions/default/archive, provider-neutral model references, Agent task binding/override, a transactional additive schema migration, and additive OpenAPI capability advertisement. The current registered adapter is Magpie compatibility only; it does not define public model identities.
- [ADR 0021](decisions/0021-cross-repository-paired-runtime-acceptance.md) closes the deterministic paired-runtime acceptance slice. `tests/agent-paired-runtime.test.ts` verifies at least two Agents over live loopback HTTP with a fake Magpie-compatible gateway, the real Fastify Runtime, and dynamically imported Pagurus clients; it changes no public route, schema, dependency, provider adapter, or execution capability.
- Pagurus ADR 0007 implements read-only multi-task history and Agent revision comparison on the existing published contract. It consumes `GET /v1/tasks` and Agent detail data, preserves legacy task records, and does not add a Runtime route, event stream, pagination contract, or write capability.
- Agent tasks are one model turn bound to the selected immutable Agent revision, the active global runtime configuration revision, and the effective provider/model. Legacy tasks without `agentId` retain their prior global v1/v2 dispatch. Agent model/provider validation happens before task creation, and the selected Agent revision is rechecked inside the SQLite creation transaction.
- The product direction is a user-managed collection of independently customizable Agents; Magpie remains one compatibility adapter, not the product's sole provider or future Agent model contract. Future Agent model references and discovery must be provider-neutral.
- Conchbase exposes versioned task, retry, cancel, event, legacy Magpie model list, provider-neutral model-catalog, Agent collection, and configuration-revision routes. Pagurus and other external clients use the Runtime API; phase-1 CLI task-state and configuration reads take short-lived private database ownership. The OpenAPI contract is the source of truth.
- The phase-1 model loop is single-turn for `schemaVersion: 1`. The deterministic composition loop is bounded for `schemaVersion: 2`. Neither is a default or canonical agent topology. User-defined composition remains topology-neutral product intent.
- `node:sqlite` persists tasks, events, and configuration revisions behind `TaskStore`. Provider calls use direct HTTP through a narrow adapter. No provider SDK, storage SDK, MCP SDK, or plugin host is installed.
- `tests/repository-guardrails.test.ts` checks AI-first entry documents, accepted ADR status, the exact 47-path `1.0.0` OpenAPI path set, loopback-only configuration, source boundaries, dependency boundaries, the public ledger's no-execution rules, and ADR 0019 parser wiring boundaries.
- The deterministic paired-runtime acceptance test skips only when the optional nested Pagurus checkout is absent. Standalone Conchbase CI keeps every other test and remains green.
- Both repositories have protected `main` rulesets against force pushes and deletion; normal pushes remain allowed.
- [ADR 0022](decisions/0022-persistent-work-runtime-direction.md) accepts the durable, event-driven, topology-neutral work direction. [ADR 0024](decisions/0024-durable-work-domain-and-public-api.md) implements the first deterministic historical contract. [ADR 0025](decisions/0025-local-first-v1-platform.md) implements the final local-first `1.0.0` target: 47 paths, work contract v2, `user_version = 3`, authenticated pairing, explicitly enabled authenticated non-loopback binding, durable work control and restart recovery, bounded work events, one local Source, a capability directory, and write-only SecretHandles with process-scoped sealed values and digest-only fixed-adapter use receipts.
- Pagurus [ADR 0008](https://github.com/2648782102/pagurus/blob/main/docs/decisions/0008-human-attention-workbench-proposal.md) and [ADR 0009](https://github.com/2648782102/pagurus/blob/main/docs/decisions/0009-read-only-attention-workbench-client.md) are historical proposal/read-only records. [ADR 0010](https://github.com/2648782102/pagurus/blob/main/docs/decisions/0010-final-local-first-client.md) implements the final paired `1.0.0` control client: work controls, bounded event evidence, capability configuration, write-only SecretHandle editing, and digest-only receipts. Pagurus remains an API client and never owns Runtime state or private files.

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

## Done in the provider tool-call parsing boundary slice

1. **Accepted direction.** ADR `0018` records the accepted internal parser, one non-streaming function tool-call shape, transient normalized observation, and explicit no-wiring/no-execution boundary.
2. **Pure parser.** `provider-tool-call.ts` validates one OpenAI Chat Completions-compatible tool call, reuses `ToolCallProposal` validation and the `arg_` digest, and returns no raw provider envelope or task/ledger identity.
3. **Executable boundary.** Deterministic parser tests and repository guardrails cover valid normalization, representative rejected shapes, unchanged `0.6.0` sixteen-path public contract, parser import boundaries, and no-wiring assertions.
4. **AI handoff.** Entry documents, README files, architecture, technology, roadmap, validation, and task queue distinguish the implemented parser from provider adapter integration and tool execution.

## Done in the explicit provider observation slice

1. **Accepted direction.** ADR `0019` records the `0.7.0` transient provider observation contract, explicit client-led ledger creation, no node selection, visible failure for live v1 observations, and the no-execution boundary.
2. **Adapter integration.** `OpenAiChatCompletionsProvider` imports the ADR 0018 parser, returns one `tool_call_observation`, accepts one whole message-shaped tool call in streaming, and keeps streaming deltas rejected. `TaskService` fails visibly and creates no ledger request.
3. **Public boundary.** `POST /v1/provider-observations/tool-calls` normalizes one bounded payload with no durable state. OpenAPI, runtime capability, versions, and all entry docs move to `0.7.0` / seventeen paths.
4. **Executable boundary.** Provider, streaming, task-service, observation-route, OpenAPI, HTTP, and repository guardrail tests cover the accepted wiring and reject auto-ledger, executor, private-state, and execution vocabulary paths.

## Next bounded slices

The first collection/editor and task-binding slice is closed by ADR 0021. ADR 0022, ADR 0023, and ADR 0024 remain historical direction/proposal/first-slice records; ADR 0025 implements their accepted local-first subset, including the SecretHandle boundary. The final local-first `1.0.0` target is closed. ADR 0022 reordered the product queue around durable work; ADR 0024 is the historical first work contract; ADR 0025 and Pagurus ADR 0010 close that final local-first `1.0.0` target. Keep conformance, accessibility, and production-scale history as separate quality layers. Do not add stable cross-process keys, real external Sources, external writes, or executable tools by silently extending the current Task, configuration, work, or SecretHandle schema. Check legacy `\/v1\/tasks` and `conchbase run` in the paired harness when changing task dispatch.

1. **Stable cross-process secrets.** Accept a separate ADR for OS-managed key custody, replayable encrypted-at-rest values, and real fixed destinations. ADR 0025 already implements process-scoped sealed values, rotation, status, use receipts, and sentinel no-leak fixtures; restart invalidation is explicit.
2. **Real external Sources.** Accept a separate ADR for GitHub/IM/email/calendar adapters, external side effects, and crash-safe reconciliation. ADR 0025 already implements one deterministic local Source with allow/deny policy.
3. **Executable tools.** Accept separate contracts for authorization, executor isolation, MCP lifecycle, Skill/plugin loading, and crash-safe side effects. Never expose a generic secret resolver or plaintext to a model, client, event, log, or error.
4. **Interface validation.** ADR 0028 and Pagurus ADR 0014 add executable credential-free provider compatibility, jsdom/CSS accessibility, and local published-contract fixtures. Keep these distinct from ADR 0021's deterministic HTTP acceptance, the completed manual/visual ADR 0007 screen walkthrough, real-provider conformance, and a real-browser accessibility audit.
5. **Persistence test boundary.** ADR 0029 adds executable abrupt-exit WAL recovery and additive migration preservation on the accepted Node 24 Ubuntu baseline. Keep these distinct from production OS/CPU/Node matrices, arbitrary crash-point recovery, retention, multi-process ownership, and normalized driver errors.
6. **History contract, if needed.** If task volume or live updates require more than the current complete list, first accept a Runtime API contract for ordering, retention, pagination, server-side filtering, cursor/reconnect semantics, and authorization. Then add a paired client ADR and implementation.
7. **Additional provider adapter.** Add only after each adapter has a defined credential/settings owner, normalized error boundary, and deterministic contract fixtures. Magpie remains a compatibility path, not the product target.
8. **Composition evolution.** Decide separately whether Agents may explicitly run a topology and what model-driven node context, delegation, concurrency, and permission semantics apply. Do not infer these from ADR 0016's deterministic executor.

## Done in the deterministic paired-runtime acceptance slice

1. **Accepted direction.** ADR `0021` records live loopback acceptance evidence with two independent Agents, Pagurus's published clients, the real Runtime, a deterministic fake gateway, and no public API change.
2. **Executable matrix.** The paired test covers Agent/task pins, stale writes, default/archive changes, overrides, configuration apply/rollback, cancellation, restart interruption, retry, event replay, legacy `/v1/tasks`, CLI compatibility, v1/v2 dispatch, deterministic composition, streaming, invalid payloads, and unsupported-provider failure without fallback.
3. **Standalone CI.** Check legacy `/v1/tasks` and `conchbase run` in the paired harness, and keep the test skipping only when the optional nested Pagurus checkout is absent. Both repositories' `npm run check`, `npm test`, and `npm run build` pass; `git diff --check` is clean.
4. **AI handoff.** Handoff, task queue, roadmaps, validation plans, READMEs, workspace notes, and repository guardrails distinguish completed deterministic local HTTP acceptance from real-provider, visual/manual UI, remote, and production-storage validation.

## Deferred capability work

- **Streaming tool-call accumulation and execution.** Later accept a separate ADR for provider-stream delta accumulation, partial arguments, cancellation, and error classification. Then separately decide durable execution results, crash-safe side effects, real executor isolation, per-tool grants, and whether `ToolCapabilityKernel` is replaced or migrated. A ledger approval is not execution permission.
- **Pagurus tool approval client.** Only after Conchbase has a real, reviewed execution and authorization workflow and Pagurus accepts its own client ADR. Never read private runtime state.
- **Agent-aware tool authorization.** Before any tool executes for a selected Agent, extend the request/approval/authorization/audit scope to include Agent identity and the pinned Agent revision, then verify runtime-wide policy and grants. Agent instructions or profile fields alone never grant capability.
- **Capability lifecycle.** Portable files, Skill/plugin/MCP bundle schemas, secret resolution, installation/enabling/grants, and process lifecycle require explicit runtime contracts and security boundaries.
- **Cross-process SecretHandles.** Stable OS-managed keys, replayable encrypted-at-rest values, arbitrary fixed adapters, and production revocation require a new accepted contract. ADR 0025 already implements process-scoped write-only handles, rotation, status, fixed-adapter use, digest-only receipts, sentinel no-leak fixtures, and the paired Pagurus editor.
- **Persistence hardening.** Add supported OS/architecture/Node CI coverage, migrations, WAL crash recovery, retention, and multi-process ownership before calling the storage layer production-ready.
- **Magpie compatibility.** Keep the existing adapter working and covered by regression fixtures while defining the provider-neutral adapter contract. Do not make upstream Magpie Agents-page integration a prerequisite for Agent management through Conchbase.
- **Authoritative client reads.** Replace direct CLI database reads with a documented Runtime API path after API parity and authentication direction are accepted. Keep the single-owner lock until that contract exists.
- **SSE compatibility and production remote UX.** Accept cursor, retention, and reconnect semantics before SSE; production remote pairing UX, deployment validation, and hardened token lifecycle require a separate accepted ADR. ADR 0025 already implements authenticated non-loopback opt-in over pairing/token metadata.

## Blocked until direction

- Generated client types built from an unaccepted schema, portable configuration files, generic secret resolution, Skill/plugin/MCP installers, real capability grants, stable cross-process secret keys, and any plaintext read path beyond ADR 0025's fixed runtime adapter.
- Stable cross-process SecretHandle keys, real Outbox writes, real external Sources, cloud persistence, BYOM daemons, and model-driven Watchdogs.
- Model-driven tool execution, public tool execution routes, real host tools, MCP servers, Skills granting tools, arbitrary plugin loading, crash-safe side effects, real executor isolation, and streaming tool-call accumulation.
- Model-driven composition nodes, delegation, concurrency, general scheduling, role registries, cyclic coordination, and automatic continuation of in-flight model or tool work after a crash.
- Running task-state CLI commands concurrently with `conchbase serve`, or treating SQLite exclusive locking as multi-process support.
- MCP process lifecycle, per-tool grants, arbitrary plugin loading, production remote pairing UX, hardened token lifecycle, desktop packaging, and cloud deployment.
- Pagurus composition forms that present one topology as the only supported shape, or that add a visual builder before its own accepted ADR.

Do not weaken or delete the repository guardrails to bypass this queue. Update them only in the same slice as an accepted ADR or a documented development-boundary change.

## Definition of done for each task

- Read `AGENTS.md`, `docs/AI_HANDOFF.md`, `docs/AI_DEVELOPMENT.md`, ADRs `0010`–`0025`, and the owning architecture/API document first.
- Keep implemented behavior separate from planned behavior in every doc/README update.
- Add deterministic tests; never use real credentials, personal data, public-network dependencies, or user runtime data in fixtures.
- Run `npm run check`, `npm test`, and `npm run build` in the affected repository.
- If a public API or shared schema changes, write an ADR with options/consequences/recommendation and record direction before implementing it.
- Report the focused slice, changed files, validation results, and update this queue. Follow the current task's explicit commit and push authorization; do not infer repository write authorization from this document.

> Final local-first target: Conchbase `1.0.0` and ADR 0025 close the exact 47-path platform contract. Write-only SecretHandle values are sealed at rest with a process-scoped AES-256-GCM key, exposed only to one runtime-owned fixed adapter, and never returned, logged, or sent to a model, client, event, or UI. Restart invalidates previously sealed values; cross-process key sources, real external adapters, executors, Sources, external writes, and tools require separate ADRs.
