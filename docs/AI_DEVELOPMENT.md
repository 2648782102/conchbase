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
- `src/runtime/task-service.ts` owns orchestration, cancellation, retry, v1/v2 dispatch, and durable progress events; `task-store.ts` owns SQLite persistence and single-instance locking; `magpie-provider.ts` is the current compatibility adapter for accepted non-streaming and streaming model calls and ADR 0019 observation normalization; `model-catalog.ts` owns the current Magpie-backed, database-free discovery path. Future Agent/model contracts must be provider-neutral, with adapter-specific transport, catalog translation, settings, and credentials behind replaceable boundaries. Keep domain decisions independent of Fastify, storage driver, and any one provider's types.
- `src/runtime/tool-capability.ts` owns the internal registry, exact versioned approvals, idempotency keys, bounded audit scalars, and replayable normalized failures for deterministic tool-fixture tests. Do not import it into the HTTP task path, persist its events in SQLite, expose its tool-prefixed event names through the public API, or connect it to a real host capability without an accepted public contract and isolation design.
- `src/runtime/tool-request.ts` owns the public provider-neutral tool request/approval ledger contract, digest-only normalized tool call proposals, composition-scoped idempotency, and identity helpers. It must not import `tool-capability.ts`, invoke an executor, store raw arguments or reasons, or emit internal execution/replay event names. `src/runtime/task-service.ts` may use it through `composition-execution.ts` identity, but must not connect it to a model provider or host tool without another accepted ADR.
- `src/runtime/provider-tool-call.ts` owns the pure, internal OpenAI Chat Completions-compatible non-streaming function tool-call parsing boundary from ADR 0018. ADR 0019 permits exactly three importers: `magpie-provider.ts`, `src/http/routes/v1/provider-observations.ts`, and its own tests. The provider returns a transient normalized observation to the task path; the task path fails visibly and never creates a ledger request or executes a tool. The observation route is pure, has no `TaskService` dependency, and writes no durable state. Streaming tool-call accumulation and execution remain separate accepted-contract work.
- `src/runtime/composition-document.ts` owns internal topology-neutral composition validation and `cmp_` identity. Only `src/runtime/configuration-document.ts` and `src/runtime/composition-execution.ts` import it directly: the former validates the public `schemaVersion: 2` composition section, and the latter computes deterministic node order, identity, and output. Do not import it into HTTP routes, `ToolCapabilityKernel`, or Pagurus, or interpret link labels as scheduling or authority.
- `src/runtime/configuration-document.ts` owns the public `schemaVersion: 1 | 2` validation/canonicalization boundary; `task-store.ts` owns durable configuration revisions and the active pointer in the same database as tasks. Keep references opaque and do not turn them into installers, grants, loaders, or secret resolvers without a new accepted ADR.
- `src/runtime/composition-execution.ts` owns the bounded deterministic graph executor plan and derived composition identity. It makes no model call and executes no tool. General scheduling, delegation, concurrency, and model-driven node work remain separate ADRs.
- Add runtime capabilities as bounded vertical slices. Keep provider output untrusted and never execute model-requested tools outside the accepted policy and approval path.
- Do not settle an open product/API decision by inventing an endpoint or composition format. Record options in an ADR and record direction before changing the public contract; update `docs/openapi.yaml` whenever current API behavior changes.
- Do not hardcode an illustrative agent composition, layer count, role name, hierarchy, or coordination pattern. ADR `0005` records topology-neutral product direction; ADR `0015` accepts the internal identity kernel; ADR `0016` accepts one bounded public graph representation and deterministic execution rule.
- An explicit ledger approval is not tool execution permission. ADR `0017` accepts durable public request/decision records; ADR `0019` accepts transient observations only. A client must explicitly call `POST /v1/tool-requests` with task and composition identity. Execution results, crash-safe side effects, and real executor isolation remain separate accepted-contract work.

## Machine feedback

- `npm run check`: TypeScript validation for application and test files.
- `npm test`: Node's built-in test runner with the `tsx` loader; covers startup configuration, provider parsing, task persistence and recovery, HTTP/OpenAPI contracts, v1/v2 configuration validation and history, deterministic composition execution and cancellation, internal deterministic runtime fixtures, and repository guardrails. Add new test files to the `test` script in `package.json`. Update `tests/repository-guardrails.test.ts` only alongside an accepted ADR or a documented development-boundary change.
- `npm run build`: clean output directory, then production compilation.
- CI runs all three commands.
- Use deterministic local data. Never use real credentials or personal runtime data as fixtures.
