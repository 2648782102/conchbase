# Decision 0043: Controlled execution v1

Status: **accepted and implemented v1 fake-executor boundary**

Date: 2026-11-14 (Asia/Shanghai).

## Context

ADR 0042 accepts controlled execution as the next direction but forbids implementation without separate contracts. The current Runtime has a capability directory, a public tool request/approval ledger, process-scoped SecretHandles, durable work state, Agent revisions and Delegations, and the completed Boss-mode `1.1.0` product loop. None of those components by themselves grants or executes a capability.

A usable first controlled-execution slice must prove the full authorization path without real external side effects. It must be deterministic, local-first, and auditable; it must not install MCP servers, load Skills/plugins, run host tools, write external systems, or expose plaintext secrets.

## Decision

1. Conchbase implements a `ControlledExecutionService` backed by a single Runtime-owned in-memory/private store interface and a deterministic fake executor. The fake executor performs no I/O, no process spawn, no network call, no file write, and no MCP/Skill/plugin lifecycle operation.
2. Public state is additive `1.2.0` with eight paths:
   - `GET /v1/execution/capabilities`
   - `GET /v1/execution/grants`
   - `POST /v1/execution/grants`
   - `POST /v1/execution/grants/{grantId}/revoke`
   - `POST /v1/execution/requests`
   - `POST /v1/execution/requests/{requestId}/decide`
   - `GET /v1/execution/requests/{requestId}`
   - `GET /v1/execution/events`
   
   The frozen `1.0.0` 47 paths and additive `1.1.0` 18 paths remain unchanged. `GET /v1/runtime` advertises optional `executionContract: "1.2.0"` and `executionPaths: 8` only when the service is configured. The eight paths include `GET /v1/execution/health` as a non-mutating contract availability read.
3. A capability is a bounded published fact with `id`, `kind`, `name`, `adapterId`, `destinationDigest`, `state`, and `capabilitiesDigest`. `recorded` means data only. `enabled`, `granted`, `approved`, `running`, `succeeded`, `failed`, and `revoked` are distinct Runtime-owned states. A capability row never grants anything by itself.
4. A grant binds a published capability to Agent identity/revision, runtime policy/capability revision, Delegation, project, WorkItem, Assignment, exact operation, destination digest, scope/capability subset, expiry sequence, and revocation version. Grants are explicit Runtime facts, not model output, Agent instructions, configuration references, or UI selections.
5. An execution request is created only with an existing active grant, a bounded normalized operation, argument digest, idempotency key, and expected grant version. It starts in `pending`. A decision with `approved` + expected version transitions to `approved`; `rejected` transitions to `rejected`. Only an approved request may be passed to the fake executor.
6. The fake executor returns a deterministic digest-only outcome, never raw arguments or plaintext values. Execution emits bounded events: `execution.grant_created`, `execution.grant_revoked`, `execution.request_created`, `execution.request_approved`, `execution.request_rejected`, `execution.started`, `execution.succeeded`, `execution.failed`. Events contain only opaque ids, digests, state strings, and bounded scalars.
7. Revocation is explicit and versioned. A stale expected version returns `409`. Revoking a grant prevents new execution requests but preserves all prior events, requests, grants, and decisions. Restart recovery rebuilds from committed execution events; no in-flight external action exists to replay.
8. Plaintext SecretHandle values remain outside model context, prompts, task state, events, logs, errors, client responses, Agent revisions, configuration documents, and UI. This decision does not introduce a generic secret resolver or any SecretHandle use in fake execution.
9. No public endpoint installs, enables, grants, loads code, executes real host tools, connects MCP, loads Skills/plugins, writes external systems, or returns plaintext. Future real executors, lifecycle operations, external Sources, external Outbox writes, and crash-safe side effects require further accepted ADRs.
10. Pagurus consumes only published `1.2.0` execution facts. It may show grants and audit states and submit explicit grant/request/decision operations, but it never computes Runtime authority, infers approval from prose, or presents a capability record as executable.

## Options

### A. Wire the existing tool request ledger to a host executor

Consequences: changes a historical ledger contract into execution permission and bypasses Delegation/WorkItem binding. Rejected.

### B. Treat capability directory records as grants

Consequences: makes configuration data authority and violates ADR 0042. Rejected.

### C. Add a versioned execution ledger with explicit grants and a fake executor

Consequences: adds an additive contract and fixtures, but proves the full authority path with no external side effect. Accepted.

## Validation

An executable fixture must prove:

- exact 47 `1.0.0`, 18 `1.1.0`, and 8 `1.2.0` paths;
- a recorded capability is not executable until an explicit grant exists;
- grant creation pins Agent/Delegation/WorkItem/Assignment/policy identity and rejects unknown or revoked Delegation;
- stale expected versions and idempotency conflicts return `409`;
- approved requests produce deterministic digest-only success; rejected requests never execute;
- revocation prevents new requests and preserves history;
- no plaintext, raw arguments, private paths, local URLs, or generic secret resolver appear in responses/events;
- Pagurus typed client and console distinguish recorded/enabled/granted/approved/running/succeeded/failed/revoked;
- both repositories pass `npm run check`, `npm test`, and `npm run build`.

## Consequences

The product now has a first executable authority loop that is safe to hand to other models: explicit grants, approvals, deterministic fake execution, and durable audit. It is not a real tool or MCP/plugin host.

> Implementation boundary: this ADR accepts only the deterministic fake-executor v1 slice.
