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

1. Accept ADRs for stable runtime-local Agent identity/lifecycle, per-Agent immutable revisions, optimistic concurrency, and separation from the existing runtime-wide policy/capability configuration.
2. Define Agent selection and defaulting, bounded instructions, provider-neutral provider/model resolution and override precedence, archive/retention, and atomic pinning of Agent id/revision plus runtime configuration revision and effective provider/model on task creation. Define retry, cancel, event/task inspection, and legacy-client behavior.
3. Specify a transactional, idempotent SQLite migration and additive API/capability strategy. Preserve all existing tasks, events, tool requests, configuration revisions and active pointer; retain v1/v2 and deterministic composition semantics.
4. Implement the Conchbase Runtime API, persistence, validation, migration, and execution contract. Keep current task/configuration/event routes and old client behavior operational.
5. Coordinate a separate Pagurus client ADR and ship Agent collection management and editor: create, edit, duplicate, select, archive, validate, apply, history, compare/rollback, task launch, and inspection. Preserve the existing UI when connecting to a runtime without Agent capability.
6. Verify at least two independent Agents end to end with deterministic fixtures before expanding into model-driven composition, tools, Skills, MCP, or plugins.

The existing configuration document is a single runtime-wide revision with opaque capability references; it is not an Agent collection. Its v2 composition executor makes no model call. Preserve these facts and their behavior while adding Agent resources. Agent instructions must never grant tools, and future tool authorization must include the pinned Agent identity/revision.

## Phase 2: bounded execution capabilities (implemented foundation)

- The internal, fixture-only tool capability kernel from [ADR 0013](decisions/0013-bounded-tool-capability-kernel.md) is implemented: registry, exact approvals, per-attempt idempotency, and deterministic audits. It is not a public tool route and cannot run real host tools.
- The versioned configuration document and revision API from [ADR 0014](decisions/0014-versioned-configuration-api.md) is implemented: validation, immutable history, apply, and rollback. It stores opaque references only; portable files, secret resolution, installers, and grants remain open.
- The internal topology-neutral composition identity kernel from [ADR 0015](decisions/0015-composition-identity-kernel.md) is implemented: canonical graph validation and `cmp_` identity.
- The bounded composition execution and public `0.5.0` schema from [ADR 0016](decisions/0016-composition-execution-and-public-schema.md) is implemented: v1/v2 configuration union, deterministic DAG traversal, node events, cancellation propagation, single-node and distinct multi-node fixtures, and no model or tool execution.
- The public tool request/approval ledger and `0.6.0` schema from [ADR 0017](decisions/0017-public-tool-request-approval-ledger.md) is implemented: normalized proposals, composition-scoped idempotency, durable request/decision records and audit events, and no tool execution.
- Define a public SSE/`Last-Event-ID` transport and retention policy through an ADR.
- The pure ADR 0018 provider tool-call parsing boundary is implemented for one non-streaming function call: normalized transient observation, bounded validation, `arg_` digest, deterministic tests, and no executor wiring.
- ADR 0019 implements explicit provider observation integration at `0.7.0`: `OpenAiChatCompletionsProvider` returns a transient observation, `POST /v1/provider-observations/tool-calls` normalizes one bounded payload, and the live v1 task path fails visibly without auto-creating a ledger request or executing a tool.
- Resume streaming tool-call accumulation, durable execution results, crash-safe side effects, and real executor isolation after the Agent collection/task-binding loop and in later accepted slices. The ledger already fixes `configurationRevisionId`, `compositionDocumentId`, `compositionNodeId`, and attempt in requests, approvals, idempotency keys, and audits.
- Define a portable profile file format, import/export, migrations, secret resolution, and capability lifecycle through later ADRs.
- Add topology-neutral, user-authored visual composition forms after the Agent collection/task-binding loop and their own accepted client ADR; the runtime schema and bounded deterministic execution contract are already accepted.
- Connect one local MCP server and one Skill directory after their lifecycle and grant boundaries are accepted.

## Phase 3: interoperability and hardening

- Publish a TypeScript client from the stable API contract.
- Add SSE or an ACP compatibility adapter where client support is useful.
- Add supported-platform storage CI, migrations, WAL crash recovery, event retention, and multi-process ownership checks.
- Add pairing and authenticated remote access before enabling network binding.

## Later

- Portable memory import/export and retrieval providers.
- Process-isolated plugin host after the trust and capability model is defined.
- Packaging and desktop service lifecycle.
