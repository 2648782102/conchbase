# Roadmap

This is a direction for staged validation, not a release commitment.

## Phase 1: real-model foundation (implemented)

- Connect one real model through a narrow replaceable provider adapter. The current adapter uses Magpie for compatibility; this first implementation does not define the product's provider choices or Agent model contract.
- Stream bounded answer-text progress through durable events and `partialOutput`.
- Persist task state, attempts, and ordered events in SQLite.
- Expose versioned task, cancel, retry, event, and model-catalog routes.
- Provide Pagurus access through the Runtime API and short-lived CLI database ownership under [ADR 0011](decisions/0011-phase-one-database-instance-ownership.md).
- Recognize process interruption and require explicit retry.

## Product priority: a user-managed Agent collection

The product target is a collection of independently customizable Agents through Pagurus. Conchbase owns Agent identities, configuration, model execution, task bindings, and permissions. The first end-to-end acceptance slice must prove at least two distinct Agents.

Agent definitions and Runtime API contracts must not depend on Magpie catalog ids, response fields, settings, or credentials. Define stable provider/model references and discovery, adapter capabilities, provider-specific settings ownership, normalized failures, and no implicit provider fallback through an accepted provider-neutral adapter contract. Preserve Magpie through its compatibility adapter and exercise the contract with deterministic fake adapters.

ADR 0020 and Conchbase 1.0.0 have implemented Agent profiles and revisions, default/archive behavior, a provider-neutral model catalog contract, additive SQLite migration, optimistic concurrency, and Agent task bindings. Agent tasks pin Agent revision, runtime configuration revision, and effective provider/model and execute one model turn. Legacy tasks retain their previous global v1/v2 behavior. ADR 0021 closes the deterministic paired-runtime acceptance matrix for the Pagurus collection/editor and two-Agent regression over live loopback HTTP.

1. **Implemented:** Ship the Pagurus Agent collection/editor using the published contract: create, edit, duplicate, select/default, archive, model selection, history and rollback, task launch and inspection. Preserve task/configuration workflows when a Runtime does not advertise `agents`.
2. **Implemented:** Verify at least two Agents with distinct instructions and models end to end over deterministic live loopback HTTP. Exercise profile changes, task pins, default/archive behavior, model override, cancellation, restart and retry, and global configuration apply/rollback.
3. **Implemented:** Preserve legacy `/v1/tasks`, CLI, Magpie compatibility, configuration v1/v2, deterministic v2 composition, streaming, cancellation, event replay, and task history in the paired acceptance harness.
4. **Client inspection slice:** Pagurus ADR 0007 consumes the existing task list and Agent detail responses to show mixed task history and compare immutable revisions. This introduces no Conchbase route or Runtime behavior change.
5. Add another provider only through a separately tested adapter implementation and its credential/settings ownership contract. Keep provider-neutral Agent and catalog schemas unchanged.
6. Decide separately whether an Agent may select the global topology and what model-driven composition semantics follow. Agent profiles do not currently invoke the v2 deterministic graph.

The existing configuration document is a single runtime-wide revision with opaque capability references; it is not an Agent collection. Its v2 composition executor makes no model call. Preserve these facts and their behavior while adding Agent resources. Agent instructions must never grant tools, and future tool authorization must include the pinned Agent identity/revision.

## Phase 2: bounded execution capabilities (implemented foundation)

- The internal, fixture-only tool capability kernel from [ADR 0013](decisions/0013-bounded-tool-capability-kernel.md) is implemented: registry, exact approvals, per-attempt idempotency, and deterministic audits. It is not a public tool route and cannot run real host tools.
- The versioned configuration document and revision API from [ADR 0014](decisions/0014-versioned-configuration-api.md) is implemented: validation, immutable history, apply, and rollback. It stores opaque references only; portable files, secret resolution, installers, and grants remain open.
- The internal topology-neutral composition identity kernel from [ADR 0015](decisions/0015-composition-identity-kernel.md) is implemented: canonical graph validation and `cmp_` identity.
- The bounded composition execution and public `0.5.0` schema from [ADR 0016](decisions/0016-composition-execution-and-public-schema.md) is implemented: v1/v2 configuration union, deterministic DAG traversal, node events, cancellation propagation, single-node and distinct multi-node fixtures, and no model or tool execution.
- The public tool request/approval ledger and `0.6.0` schema from [ADR 0017](decisions/0017-public-tool-request-approval-ledger.md) is implemented: normalized proposals, composition-scoped idempotency, durable request/decision records and audit events, and no tool execution.
- Define a public SSE/`Last-Event-ID` transport and retention policy through an ADR.
- Define a server-side task history query contract only if the current complete `GET /v1/tasks` response no longer serves local clients; include ordering, retention, pagination, filtering, authorization, and live update semantics in that ADR.
- The pure ADR 0018 provider tool-call parsing boundary is implemented for one non-streaming function call: normalized transient observation, bounded validation, `arg_` digest, deterministic tests, and no executor wiring.
- ADR 0019 implements explicit provider observation integration at `0.7.0`: `OpenAiChatCompletionsProvider` returns a transient observation, `POST /v1/provider-observations/tool-calls` normalizes one bounded payload, and the live v1 task path fails visibly without auto-creating a ledger request or executing a tool.
- Resume streaming tool-call accumulation, durable execution results, crash-safe side effects, and real executor isolation after the Agent collection/task-binding loop and in later accepted slices. The ledger already fixes `configurationRevisionId`, `compositionDocumentId`, `compositionNodeId`, and attempt in requests, approvals, idempotency keys, and audits.
- Define a portable profile file format, import/export, migrations, secret resolution, and capability lifecycle through later ADRs.
- Add topology-neutral, user-authored visual composition forms after the Agent collection/task-binding loop and their own accepted client ADR; the runtime schema and bounded deterministic execution contract are already accepted.
- Connect one local MCP server and one Skill directory after their lifecycle and grant boundaries are accepted.

## Product direction: durable, event-driven work (final local-first slice implemented)

ADR 0022 accepts a local-first, persistent, event-driven, topology-neutral personal Agent Runtime. ADR 0024 is the historical first `Source / Trigger / Thread / Mandate / WorkItem / Assignment / Outbox / DeliveryReceipt` contract. ADR 0025 completes the final local-first `1.0.0` target: 47 paths, work contract v2, authenticated pairing, explicitly enabled authenticated non-loopback binding, durable start/stop/complete and restart recovery, Outbox/DeliveryReceipt decisions, bounded work events, one local Source, a capability directory, and write-only SecretHandles. Pagurus ADR 0010 implements the paired control client. Router/Worker and layered roles remain examples, not a canonical topology.

ADR 0025 implements asynchronous control, restart reconciliation, a deterministic local Source, capability records, and process-scoped write-only SecretHandles. Pagurus ADR 0008/0009 remain historical records; ADR 0010 implements the control workbench, capability panel, write-only editor, and digest-only receipt view. Stable cross-process keys, real external Sources, external writes, and executable tools require new ADRs.

1. **Implemented:** ADR 0024 accepts the historical durable-work domain and deterministic fake/manual Trigger intake.
2. **Implemented:** ADR 0025 accepts durable start/stop/complete, restart recovery, Outbox/DeliveryReceipt decisions, events, local Source policy, capability records, authentication/pairing metadata, and process-scoped SecretHandles. Pagurus ADR 0010 implements the paired `1.0.0` control client.
3. **Deferred:** stable cross-process keys, real external Sources, external writes, and executable tools require new ADRs.

## Phase 3: interoperability and hardening

- Publish a TypeScript client from the stable API contract.
- Add SSE or an ACP compatibility adapter where client support is useful.
- Add supported-platform storage CI, migrations, WAL crash recovery, event retention, and multi-process ownership checks.
- Keep ADR 0025's explicit authenticated non-loopback opt-in; add production remote pairing UX, deployment validation, and hardened token lifecycle only through a separate accepted ADR.

## Later

- Portable memory import/export and retrieval providers.
- Process-isolated plugin host after the trust and capability model is defined.
- Packaging and desktop service lifecycle.

> Final local-first target: Conchbase `1.0.0` and ADR 0025 close the exact 47-path platform contract. Write-only SecretHandle values are sealed at rest with a process-scoped AES-256-GCM key, exposed only to one runtime-owned fixed adapter, and never returned, logged, or sent to a model, client, event, or UI. Restart invalidates previously sealed values; cross-process key sources, real external adapters, executors, Sources, external writes, and tools require separate ADRs.
