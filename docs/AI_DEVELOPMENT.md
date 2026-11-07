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

- `src/main.ts` owns process startup and listener lifecycle.
- `src/config/` parses environment and validates startup configuration.
- `src/http/` translates the versioned HTTP API to and from runtime behavior.
- Future runtime capabilities should be added as bounded vertical slices. Keep domain decisions independent of Fastify, model-provider SDKs, and storage drivers.
- Do not settle an open product/API decision by inventing an endpoint or persistence format. Record options in an ADR and ask for direction when the public contract depends on it.
- Do not hardcode an illustrative agent composition, layer count, role name, hierarchy, or coordination pattern. ADR `0005` records topology-neutral product direction; its schema remains unresolved.

## Machine feedback

- `npm run check`: TypeScript validation for application and test files.
- `npm test`: Node's built-in test runner with the `tsx` loader; covers startup configuration, HTTP/OpenAPI response contracts, internal deterministic runtime fixtures, and repository guardrails. Add new test files to the `test` script in `package.json`. Update `tests/repository-guardrails.test.ts` only alongside an accepted ADR or a documented development-boundary change.
- `npm run build`: clean output directory, then production compilation.
- CI runs all three commands.
- Use deterministic local data. Never use real credentials or personal runtime data as fixtures.
