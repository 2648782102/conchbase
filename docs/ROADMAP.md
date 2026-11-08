# Roadmap

This is a direction for staged validation, not a release commitment.

## Phase 1: real-model foundation (implemented)

- Connect one real model through a narrow local Magpie adapter.
- Stream bounded answer-text progress through durable events and `partialOutput`.
- Persist task state, attempts, and ordered events in SQLite.
- Expose versioned task, cancel, retry, event, and model-catalog routes.
- Provide CLI and Pagurus access through the same Runtime API.
- Recognize process interruption and require explicit retry.

## Phase 2: bounded execution capabilities

- The internal, fixture-only tool capability kernel from [ADR 0013](decisions/0013-bounded-tool-capability-kernel.md) is implemented: registry, exact approvals, per-attempt idempotency, and deterministic audits. It is not a public tool route and cannot run real host tools.
- Define a public SSE/`Last-Event-ID` transport and retention policy through an ADR.
- Define and implement a public tool/approval contract, durable audit storage, crash-safe side effects, and real executor isolation in a later accepted slice.
- Define a portable, versioned profile schema with validation, revision history, rollback, and secret references.
- Add topology-neutral, user-authored composition with single-node and distinct multi-node fixtures.
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
