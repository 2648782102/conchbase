# AI development guide

## Development target

AI coding agents are the primary implementation workflow. Optimize repository context, code boundaries, and feedback loops for an agent to complete a well-scoped change without relying on chat history. Human maintainability is not a product requirement. This describes how the software is developed; Conchbase itself remains open to CLI, graphical, and third-party clients.

Prefer explicit types, local ownership, small vertical slices, and executable checks. Avoid giant files, hidden cross-module behavior, speculative frameworks, and duplicate sources of truth. Add an abstraction when it protects a real replacement, security, or domain boundary.

## Change loop

1. Read `AGENTS.md`, this guide, and the owning architecture/API document. Treat the current repository state as authoritative.
2. Inspect `git status` and the files in the affected slice before editing. Preserve unrelated user changes.
3. Make the smallest end-to-end change that satisfies the task. Update OpenAPI and adjacent docs whenever current API behavior changes.
4. Run `npm run check`, `npm test`, and `npm run build`. Do not claim behavior that is only planned.
5. Report the files changed, commands run, results, and any unresolved decision.

## Runtime code boundaries

- `src/main.ts` owns server startup and listener lifecycle; `src/cli.ts` owns CLI commands.
- `src/config/` parses environment and validates startup configuration.
- `src/http/` translates the versioned HTTP API to and from runtime behavior.
- `src/runtime/task-service.ts` owns orchestration; `task-store.ts` owns SQLite persistence and single-instance locking; `magpie-provider.ts` owns the accepted provider adapter; `model-catalog.ts` owns database-free model discovery. Keep domain decisions independent of Fastify and storage driver types.
- Add runtime capabilities as bounded vertical slices. Keep provider output untrusted and never execute model-requested tools outside the accepted policy and approval path.
- Do not settle an open product/API decision by inventing an endpoint, profile schema, or composition format. Record options in an ADR and record direction before changing the public contract.
- Do not hardcode an illustrative agent composition, layer count, role name, hierarchy, or coordination pattern. ADR `0005` records topology-neutral product direction; its schema remains unresolved.

## Machine feedback

- `npm run check`: TypeScript validation for application and test files.
- `npm test`: Node's built-in test runner with the `tsx` loader; covers startup configuration, provider parsing, task persistence and recovery, HTTP/OpenAPI contracts, internal deterministic runtime fixtures, and repository guardrails. Add new test files to the `test` script in `package.json`. Update `tests/repository-guardrails.test.ts` only alongside an accepted ADR or a documented development-boundary change.
- `npm run build`: clean output directory, then production compilation.
- CI runs all three commands.
- Use deterministic local data. Never use real credentials or personal runtime data as fixtures.
