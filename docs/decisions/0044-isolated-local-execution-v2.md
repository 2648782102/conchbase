# Decision 0044: Isolated local execution v2

Status: **accepted and implemented isolated local execution v2**

Date: 2026-11-14 (Asia/Shanghai).

## Context

ADR 0043 implements controlled execution v1 as a deterministic fake executor with explicit grants, approvals, revocation, and audit. That proves the authority path but does not execute a real process, does not persist execution runs, and has no restart recovery. ADR 0042 still forbids real MCP/Skill/plugin lifecycle, external Sources, external writes, production secret custody, and unrestricted host tools.

A useful second slice must cross the process boundary without crossing the external-side-effect boundary. It must prove that Conchbase can own an isolated local executor child process, run only a bounded deterministic operation, record durable run state, recover after process loss, and expose digest-only results. It must not give a model or client arbitrary command, path, network, credential, or filesystem control.

## Decision

1. Conchbase implements additive `1.3.0` execution-run capabilities on top of `1.2.0`. The frozen `1.0.0` 47 paths, additive `1.1.0` 18 paths, and additive `1.2.0` 8 paths remain unchanged. `GET /v1/runtime` keeps `executionContract: "1.2.0"` and `executionPaths: 8` for existing clients, and additionally advertises optional `executionRunContract: "1.3.0"` and `executionRunPaths: 8` only when the `1.3.0` service is configured.
2. The `1.3.0` service owns a Runtime-created isolated local executor. The executor is a short-lived Node child process launched with a fixed script path, a fixed argv shape, a sanitized environment, no inherited provider credentials, no network API, no arbitrary cwd, no shell, and no user-specified file path. It accepts one bounded operation from a closed allowlist and returns only a digest and bounded scalar metadata on stdout.
3. Accepted v2 operations are limited to deterministic local computations: `hash`, `echo_length`, and `fixed_matrix`. Operation arguments stay digest-only in public state. No operation reads files, writes files, opens sockets, loads npm packages from user input, spawns descendants, or accepts arbitrary commands.
4. A run is a durable Runtime fact with `id`, `requestId`, `grantId`, `operation`, `argumentsDigest`, `adapterId`, `state`, `attempt`, `expectedVersion`, `workerPidDigest`, `exitCode`, `resultDigest`, `errorDigest`, timestamps, and an idempotency key. States are `queued`, `running`, `succeeded`, `failed`, `cancelled`, and `interrupted`.
5. A run is created only after an approved `1.2.0` request, with an active grant and expected versions. `POST /v1/execution/runs` accepts a bounded request id, expected request version, operation, arguments digest, idempotency key, and adapter id. Exact idempotent replay returns the existing run; conflicting reuse returns `409`.
6. A run starts only through `POST /v1/execution/runs/{runId}/start` using the published expected version. The Runtime writes `running` before spawning, then records `succeeded` or `failed` after child exit. If the Runtime restarts while a run is `running`, startup marks it `interrupted`; the explicit `POST /v1/execution/runs/{runId}/recover` retries from the same bounded operation and idempotency key, preserving prior events.
7. `POST /v1/execution/runs/{runId}/cancel` uses the published expected version and prevents queued runs from starting. In-flight child cancellation is process-scoped only; no external side effect is replayed. No external work is performed.
8. New public paths are additive and exact:
   - `GET /v1/execution/runs`
   - `POST /v1/execution/runs`
   - `GET /v1/execution/runs/{runId}`
   - `POST /v1/execution/runs/{runId}/start`
   - `POST /v1/execution/runs/{runId}/cancel`
   - `POST /v1/execution/runs/{runId}/recover`
   - `GET /v1/execution/runs/{runId}/events`
   - `GET /v1/execution/adapters`
   
   These eight `1.3.0` run paths are additive; discovery uses the separate `executionRunContract` / `executionRunPaths` fields so existing `1.2.0` clients keep working.
9. Persistence uses the existing private SQLite owner pattern by replaying bounded execution-run action JSON. No second SQLite owner, no new public schema for Task/WorkItem/SecretHandle, and no client access to private files. All public responses and events contain only opaque ids, digests, bounded scalars, and state names.
10. Plaintext SecretHandle values remain outside model context, prompts, task state, events, logs, errors, client responses, Agent revisions, configuration documents, and UI. The isolated executor receives no SecretHandle values. There is no generic secret resolver.
11. Pagurus ADR 0021 consumes the `1.3.0` run facts through a typed client and a bounded run panel. It never computes authority, starts arbitrary operations, displays raw arguments, or presents an interrupted run as completed.
12. Real MCP servers, Skill/plugin loaders, external Sources, external Outbox writes, provider-managed credentials, production remote pairing, and arbitrary host tool execution remain blocked and require further accepted ADRs.

## Options

### A. Spawn arbitrary shell commands from a grant

Consequences: converts a model/client request into host authority and creates an exfiltration primitive. Rejected.

### B. Keep only the v1 in-process fake executor

Consequences: never proves process isolation, durable run state, or restart recovery. Rejected.

### C. Add a fixed local child-process executor with closed operations and durable replay

Consequences: crosses the process boundary safely while preserving the no-external-side-effect boundary. Accepted.

## Validation

An executable fixture must prove:

- exact additive path counts and optional `1.3.0` discovery;
- rejected grant/request cannot create a run;
- isolated child process produces deterministic digest-only results for all allowlisted operations and rejects unknown operations;
- no environment credentials, arbitrary paths, URLs, network calls, shell commands, or raw arguments enter the child/API/events;
- running state persists before spawn and is marked interrupted after service rebuild;
- explicit recovery creates one fresh attempt without changing the idempotency identity;
- stale expected versions, idempotency conflicts, and cancelled runs return `409`;
- results, errors, and events contain no plaintext, private paths, or generic resolver vocabulary;
- Pagurus typed client and console distinguish queued/running/succeeded/failed/cancelled/interrupted and read run events;
- both repositories pass `npm run check`, `npm test`, and `npm run build`.

## Consequences

Conchbase now owns real local execution with deterministic process isolation and durable recovery, but still does not own real external capability lifecycle or external side effects.

> Implementation boundary: this ADR accepts only isolated local deterministic operations with no external write.
