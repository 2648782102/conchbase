# Instructions for coding agents

This project is built primarily by AI coding agents. Optimize architecture, documentation, and validation for agents to understand, change, and verify bounded tasks quickly. Human handoff is not a product requirement. Keep code explicit and legible; this principle is not permission for opaque code or speculative abstraction.

Read `docs/AI_HANDOFF.md` first, then `docs/AI_DEVELOPMENT.md` and the linked architecture, API, and technology documents. Treat the Git repository as the source of truth; do not rely on context from another chat.

## Product invariants

- Conchbase is the agent execution authority. CLI, Pagurus, IDEs, and other interfaces are clients.
- This project is meant to own the agent loop. It is not only a memory/context overlay for another agent.
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
- Run `npm run check`, `npm test`, and `npm run build` after code changes. CI runs all three commands.

