# Roadmap

This is a direction for staged validation, not a release commitment.

## Foundation

- Version the runtime, task, configuration, and event contracts.
- Add profile validation and an explicit active configuration revision.
- Define task lifecycle, cancellation, and event replay behavior.

## First usable runtime

- Add one model provider through the provider adapter.
- Persist sessions, tasks, approvals, and ordered events.
- Add a policy gate before every tool execution.
- Connect one local MCP server and one Skill directory.

## Interoperability

- Publish a TypeScript client from the stable API contract.
- Add an ACP compatibility adapter where client support is useful.
- Add pairing and authenticated remote access before enabling network binding.

## Later

- Portable memory import/export and retrieval providers.
- Process-isolated plugin host after the trust and capability model is defined.
- Packaging and desktop service lifecycle.
