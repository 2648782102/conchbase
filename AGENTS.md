# Instructions for coding agents

This project is built primarily by AI coding agents. Optimize architecture, documentation, and validation for agents to understand, change, and verify bounded tasks quickly. Human handoff is not a product requirement. Keep code explicit and legible; this principle is not permission for opaque code or speculative abstraction.

Read `docs/AI_HANDOFF.md` first, then `docs/AI_DEVELOPMENT.md` and the linked architecture, API, and technology documents. Treat the Git repository as the source of truth; do not rely on context from another chat.

## Product invariants

- Conchbase is the agent execution authority. CLI, Pagurus, IDEs, and other interfaces are clients.
- The paired product direction is user-managed, independently customizable Agents through clients such as Pagurus. Conchbase owns stable Agent identities and versioned Agent definitions; Agent revisions must remain distinct from runtime-wide policy/capability configuration unless an ADR explicitly chooses otherwise. Each Agent-backed task must pin both applicable revisions. Clients must not create competing schemas.
- Provider integrations are replaceable adapters. Magpie is one currently supported compatibility path, not the product's required provider or an Agent configuration dependency. Keep Agent model references and Runtime API contracts provider-neutral; provider credentials and provider-specific settings stay behind their adapter boundary.
- This project is meant to own the agent loop. It is not only a memory/context overlay for another agent.
- ADR 0022 accepts the product direction of durable, event-driven, topology-neutral work. ADR 0024 accepts and implements the first deterministic durable-work contract: `0.9.0`, 29 routes, `durable-work-contract`, and `user_version = 2`. Sessions and single-turn Tasks remain implementation details; the existing `Task` resource is unchanged. ADR 0025 and later own asynchronous execution, start/stop, background completion, and recovery.
- ADR 0023 proposes write-only SecretHandles. Plaintext must never enter model context, prompts, task state, durable events, logs, errors, client responses, Agent revisions, or configuration documents. Only a runtime-owned, authorized adapter may inject a value into a fixed destination; never give a model or tool a generic value resolver.
- Never execute a tool outside the runtime policy and approval path.
- A Skill supplies instructions; it does not grant tool permissions.
- Keep loopback-only binding until authentication and pairing are designed and implemented.
- Do not let a UI read or write Conchbase's private files or database.

## Change discipline

- Distinguish implemented behavior from roadmap items. Do not describe planned features as present.
- Keep API, configuration, and event contracts versioned; update `docs/openapi.yaml` when a current endpoint changes.
- Record meaningful architectural choices in `docs/decisions/` and mark undecided choices as proposals.
- Do not introduce real credentials, user data, external service calls, or machine-specific paths.
- Before changing an unresolved decision in `docs/AI_HANDOFF.md`, surface the trade-off and record the decision.
- Keep `tests/repository-guardrails.test.ts` passing; update it only alongside an accepted ADR or a documented development-boundary change.
- Read `src/runtime/work-contract.ts` and `src/runtime/work-store.ts` before changing durable-work state; do not add a canonical topology, secret resolver, external write, or second SQLite owner.
- Run `npm run check`, `npm test`, and `npm run build` after code changes. CI runs all three commands.

