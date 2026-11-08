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
- `src/runtime/task-service.ts` owns orchestration and durable progress events; `task-store.ts` owns SQLite persistence and single-instance locking; `magpie-provider.ts` owns the accepted non-streaming and streaming provider adapters; `model-catalog.ts` owns database-free model discovery. Keep domain decisions independent of Fastify and storage driver types.
- `src/runtime/tool-capability.ts` owns the internal registry, exact versioned approvals, idempotency keys, bounded audit scalars, and replayable normalized failures for deterministic tool-fixture tests. Do not import it into the HTTP task path, persist its events in SQLite, expose its tool-prefixed event names through the public API, or connect it to a real host capability without an accepted public contract and isolation design.
- `src/runtime/composition-document.ts` owns internal topology-neutral composition validation and `cmp_` identity. It is an internal deterministic data boundary under [ADR 0015](decisions/0015-composition-identity-kernel.md). Do not import it into `TaskService`, HTTP routes, `ToolCapabilityKernel`, or Pagurus, persist it in SQLite, add it to `schemaVersion: 1` configuration documents, or interpret link labels as scheduling or authority before a separate accepted public contract.
- `src/runtime/configuration-document.ts` owns the public `schemaVersion: 1` validation/canonicalization boundary; `task-store.ts` owns durable configuration revisions and the active pointer in the same database as tasks. Keep references opaque and do not turn them into installers, grants, loaders, or secret resolvers without a new accepted ADR.
- Add runtime capabilities as bounded vertical slices. Keep provider output untrusted and never execute model-requested tools outside the accepted policy and approval path.
- Do not settle an open product/API decision by inventing an endpoint or composition format. Record options in an ADR and record direction before changing the public contract; update `docs/openapi.yaml` whenever current API behavior changes.
- Do not hardcode an illustrative agent composition, layer count, role name, hierarchy, or coordination pattern. ADR `0005` records topology-neutral product direction; ADR `0015` accepts an internal identity kernel, and the public schema remains unresolved.

## Machine feedback

- `npm run check`: TypeScript validation for application and test files.
- `npm test`: Node's built-in test runner with the `tsx` loader; covers startup configuration, provider parsing, task persistence and recovery, HTTP/OpenAPI contracts, internal deterministic runtime fixtures, and repository guardrails. Add new test files to the `test` script in `package.json`. Update `tests/repository-guardrails.test.ts` only alongside an accepted ADR or a documented development-boundary change.
- `npm run build`: clean output directory, then production compilation.
- CI runs all three commands.
- Use deterministic local data. Never use real credentials or personal runtime data as fixtures.
