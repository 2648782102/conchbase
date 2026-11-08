# Roadmap

This is a direction for staged validation, not a release commitment.

## Phase 1: real-model foundation (implemented)

- Connect one real model through a narrow local Magpie adapter.
- Stream bounded answer-text progress through durable events and `partialOutput`.
- Persist task state, attempts, and ordered events in SQLite.
- Expose versioned task, cancel, retry, event, and model-catalog routes.
- Provide Pagurus access through the Runtime API and short-lived CLI database ownership under [ADR 0011](decisions/0011-phase-one-database-instance-ownership.md).
- Recognize process interruption and require explicit retry.

## Phase 2: bounded execution capabilities

- The internal, fixture-only tool capability kernel from [ADR 0013](decisions/0013-bounded-tool-capability-kernel.md) is implemented: registry, exact approvals, per-attempt idempotency, and deterministic audits. It is not a public tool route and cannot run real host tools.
- The versioned configuration document and revision API from [ADR 0014](decisions/0014-versioned-configuration-api.md) is implemented: validation, immutable history, apply, and rollback. It stores opaque references only; portable files, secret resolution, installers, and grants remain open.
- The internal topology-neutral composition identity kernel from [ADR 0015](decisions/0015-composition-identity-kernel.md) is implemented: canonical graph validation and `cmp_` identity.
- The bounded composition execution and public `0.5.0` schema from [ADR 0016](decisions/0016-composition-execution-and-public-schema.md) is implemented: v1/v2 configuration union, deterministic DAG traversal, node events, cancellation propagation, single-node and distinct multi-node fixtures, and no model or tool execution.
- The public tool request/approval ledger and `0.6.0` schema from [ADR 0017](decisions/0017-public-tool-request-approval-ledger.md) is implemented: normalized proposals, composition-scoped idempotency, durable request/decision records and audit events, and no tool execution.
- Define a public SSE/`Last-Event-ID` transport and retention policy through an ADR.
- The pure ADR 0018 provider tool-call parsing boundary is implemented for one non-streaming function call: normalized transient observation, bounded validation, `arg_` digest, deterministic tests, and no provider/task/executor wiring. It changes no public contract.
- Define and implement provider adapter integration, streaming tool-call accumulation, durable execution results, crash-safe side effects, and real executor isolation in later accepted slices. The ledger already fixes `configurationRevisionId`, `compositionDocumentId`, `compositionNodeId`, and attempt in requests, approvals, idempotency keys, and audits.
- Define a portable profile file format, import/export, migrations, secret resolution, and capability lifecycle through later ADRs.
- Add topology-neutral, user-authored visual composition forms after their own accepted client ADR; the runtime schema and bounded execution contract are already accepted.
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
- Optional upstream Magpie Agents-page adapter once Conchbase configuration is stable.
