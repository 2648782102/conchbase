# Decision 0021: Deterministic paired-runtime acceptance evidence

Status: **accepted development-boundary change; no public API contract changes**

Date: 2026-11-10 (Asia/Shanghai).

## Context

Conchbase [ADR 0020](0020-multi-agent-and-provider-neutral-model-contract.md) publishes runtime-local Agent identities, immutable revisions, provider-neutral model references, and Agent task pinning. Pagurus [ADR 0006](https://github.com/2648782102/pagurus/blob/main/docs/decisions/0006-agent-management-client.md) accepts the client editing and task-selection surface. Both repositories have deterministic unit and Fastify/Vitest fixtures, but the active cross-repository slice in `docs/AI_TASK_QUEUE.md` still needs evidence that the two API clients and the Runtime agree over a live loopback HTTP connection, with at least two independent Agents and no real model credentials.

The verification must not add a route, schema, dependency, provider adapter, or execution capability. Fastify injection alone does not prove the client's relative `/v1/...` fetch paths, HTTP status mapping, or the Runtime listener boundary. A real model provider is not deterministic and CI must not use credentials or the public network.

## Decision

Add a Conchbase-owned, opt-in paired-runtime acceptance test that starts two loopback `node:http` servers: a deterministic fake Magpie compatibility gateway and the real Fastify Runtime with a temporary SQLite database. The test maps Pagurus's relative Runtime API fetches to the live Runtime origin, then dynamically imports Pagurus's published Agent, task, configuration, and runtime clients. It does not import Pagurus source statically, copy client schemas, or let the UI read private runtime files.

The test skips cleanly when the optional nested Pagurus checkout is absent, so the standalone Conchbase CI checkout remains green. When both repositories are present, it verifies:

- two independent Agents with distinct instructions and provider-neutral model selections, plus a stable model catalog and default selection;
- task and queued-event pins that survive Agent edits, default changes, configuration apply/rollback, archive, retry, and explicit model override;
- stale optimistic writes, unsupported provider failure without fallback or task creation, legacy `/v1/tasks`, and `conchbase run`;
- cancellation, process interruption, explicit retry, durable event replay, v1/v2 global configuration dispatch, deterministic v2 composition, and Magpie-compatible streaming;
- validation failure before task creation and no private database access from Pagurus clients.

The fake gateway exposes only `/v1/models` and `/v1/chat/completions`, returns deterministic SSE frames, and supports a bounded delay for cancellation. All paths, host names, ports, database files, and prompts are temporary fixtures. The Runtime binds to `127.0.0.1` only. No real credential, user data, public-network call, or real model provider is used.

## Options

### A. Keep unit and injection fixtures only

Consequences: no new test infrastructure, but cross-process fetch routing, relative API paths, HTTP error mapping, and real listener lifecycle remain unverified. Rejected because the queue explicitly asks for live paired-runtime evidence.

### B. Add a general cross-repository test framework or generated client

Consequences: broader future reuse, but adds a second source of truth and new dependencies before an accepted contract. Rejected because this slice is acceptance evidence, not a new product boundary.

### C. Deterministic live loopback harness with optional Pagurus checkout (recommended)

Consequences: proves the published clients against the real Runtime over HTTP while preserving standalone CI. The test is intentionally narrow and skips only when the optional peer repository is absent. This is the accepted development boundary.

## Consequences

`tests/agent-paired-runtime.test.ts` joins `npm test` through `package.json`. The test file uses `node:http`, `node:fs`, `node:child_process`, and dynamic file URL imports; repository guardrails permit these in tests and keep them forbidden in Pagurus `src/`. The exact `0.8.0` 25-route OpenAPI contract, package dependency baseline, and product invariants remain unchanged.

The acceptance evidence is deterministic local HTTP plus a fake provider adapter. It does not claim a real Magpie model call, remote access, production storage recovery, or visual/manual UI validation. Those remain separate validation layers in both repositories' `docs/VALIDATION_PLAN.md`.

## Implementation notes

- Pagurus's `cancelTask` and `retryTask` bodyless POST operations no longer send `Content-Type: application/json`. Conchbase's task error handler maps Fastify's empty-JSON-body `400` to the documented contract error instead of an internal `500`. Both behaviors have regression tests.
- `TaskService.stop()` is an asynchronous shutdown boundary used by the paired harness. It sets an internal stopping flag, aborts active controllers, waits for in-flight executions, and closes the store. Aborted work during shutdown remains nonterminal so a fresh `TaskService` startup records `interrupted`; explicit `cancelTask` remains the only path that records `cancelled`. `close()` remains the existing synchronous store-close boundary.
- The fake gateway's bounded delay is one-shot per prompt suffix. This keeps cancellation and restart-interruption fixtures deterministic without delaying their explicit retries.
- The paired harness runs the CLI compatibility check through an asynchronous child process so its fake loopback gateway stays responsive, and it restarts the Runtime before final Pagurus client reads after that CLI database ownership ends.
- Full validation passed with the nested Pagurus checkout present: Conchbase `npm run check`, `npm test` (101 tests), and `npm run build`; Pagurus `npm run check`, `npm test` (51 tests), and `npm run build`; and `git diff --check` in both repositories. The standalone Conchbase checkout skips only the paired acceptance test while all other tests continue to run.

## Validation

- Run `npm run check`, `npm test`, and `npm run build` in Conchbase with the Pagurus checkout present.
- Run `npm run check`, `npm test`, and `npm run build` in Pagurus.
- Run `git diff --check` in both repositories.
- Confirm CI remains usable when Conchbase is checked out alone: the paired acceptance test reports skip, while all standalone tests continue to run.
- Update the task queue, roadmaps, validation plans, and AI handoff documents to record completed local HTTP acceptance without overstating it as real-provider or visual acceptance.
