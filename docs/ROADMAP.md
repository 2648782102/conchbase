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
- The versioned configuration document and revision API from [ADR 0014](decisions/0014-versioned-configuration-api.md) is implemented: validation, immutable history, apply, and rollback. It stores opaque references only; portable files, secret resolution, installers, grants, and composition remain open.
- The internal topology-neutral composition identity kernel from [ADR 0015](decisions/0015-composition-identity-kernel.md) is implemented: canonical graph validation and `cmp_` identity with no public route, execution semantics, or capability grants.
- Define a public SSE/`Last-Event-ID` transport and retention policy through an ADR.
- Accept a new configuration schema version and bounded composition execution with task/event identity and cancellation propagation, using single-node and distinct multi-node fixtures.
- Define and implement a public tool/approval contract, durable audit storage, crash-safe side effects, and real executor isolation in a later accepted slice, including composition node identity in approvals and audits.
- Define a portable profile file format, import/export, migrations, secret resolution, and capability lifecycle through later ADRs.
- Add topology-neutral, user-authored public composition forms after the runtime schema and execution contract are accepted.
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
