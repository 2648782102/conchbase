# Decision 0038: Organization public contract 1.1.0

Status: **accepted public-contract direction; implementation gated on paired Pagurus ADR**

Date: 2026-11-13 (Asia/Shanghai).

## Context

ADR 0025 freezes the exact 47-path local-first `1.0.0` Runtime API. ADR 0034 requires a later public-contract ADR before organization state and commands can be used by CLI, Pagurus, or third-party clients. ADRs 0035–0037 add internal persistence, execution planning, and digest-only dynamic-Agent projection but deliberately publish no route.

The long-range target cannot be complete while organization behavior remains private to the Runtime. This decision fixes a new versioned contract without silently changing `1.0.0`.

## Decision

### 1. Version and boundary

The organization API version is `1.1.0`. It is additive to `1.0.0` and uses the same base URL, authentication, loopback default, and error envelope conventions. The `1.0.0` 47-path set remains frozen and available. `docs/openapi.yaml` becomes the single source of truth for both versions only when this ADR's exact path set is implemented.

The exact organization path set is eighteen paths:

```text
/v1/organization/session
/v1/organization/session/intents
/v1/organization/projects
/v1/organization/projects/{projectId}
/v1/organization/projects/{projectId}/threads
/v1/organization/agents/proposals
/v1/organization/agents/proposals/{proposalId}
/v1/organization/delegations
/v1/organization/delegations/{delegationId}
/v1/organization/work-items
/v1/organization/work-items/{workItemId}
/v1/organization/reports
/v1/organization/reports/{reportId}
/v1/organization/attention
/v1/organization/attention/{attentionId}
/v1/organization/attention/{attentionId}/answer
/v1/organization/attention/{attentionId}/withdraw
/v1/organization/events
```

### 2. Read/write semantics

Clients submit bounded natural-language intents only to the primary session. The Runtime, not the client, turns intents into structured organization actions. Clients may read published Projects, Agent proposal audit views, Delegations, WorkItem views, Reports, AttentionRequests, and organization events.

Clients may answer or withdraw an open AttentionRequest. All other lifecycle changes—including project state, worker authority, archive, offboard, and resume—are Runtime-owned results of validated actions and policy. Reserved command paths for lifecycle control are not accepted by this contract.

An accepted intent returns `202` with an opaque `intentId` and current `expectedSequence`. A replayed `intentId` with the same body returns the original result; a conflicting replay returns `409`. Project, Delegation, WorkItem, Report, Attention, and proposal reads return `200`; missing opaque ids return `404`. Attention answer and withdrawal require the published `expectedVersion`; stale versions return `409`.

### 3. Publication boundary

The API publishes immutable facts and active published state. It never exposes model drafts, raw transcripts, private files, provider sessions, database rows, plaintext SecretHandle values, local paths, generic secret resolvers, or locally computed authority. Agent proposal views expose bounded digests, opaque references, validation status, and rejection codes; they never expose raw rejected payloads or synthesized instructions.

Boss/HR/employee are not role enums. The contract uses opaque ids, project references, delegation references, and bounded state strings accepted by ADRs 0031–0033.

### 4. Event and cursor semantics

`GET /v1/organization/events` reads immutable organization events in strict ascending sequence. `after` is an opaque event id; `limit` is an integer from 1 to 1000 with a default of 100. An unknown cursor returns `400`. The response includes `nextCursor` and `hasMore`; replay from a cursor is deterministic for persisted events. The contract does not advertise SSE, retention, or reconnect semantics in `1.1.0`.

### 5. Version discovery

`GET /v1/runtime` may advertise `organizationContract: "1.1.0"` and an `organizationPaths` count of 18 only after implementation. The `1.0.0` capability list and path set remain unchanged. Clients must not infer endpoints from capability strings alone.

### 6. Paired client gate

Pagurus must accept a paired client ADR covering typed clients, primary-conversation rendering, attention ordering, project inspection, report/archive browsing, and no-second-schema invariants before any organization UI is presented as connected behavior. Static fixtures remain non-authoritative until that gate and the Runtime implementation are complete.

## Options

### A. Add organization routes to the frozen 47-path `1.0.0` contract

Consequences: faster client work but breaks the accepted source-of-truth boundary. Rejected.

### B. Keep organization behavior private indefinitely

Consequences: preserves safety but fails the product goal of CLI/GUI/third-party access. Rejected.

### C. Publish a new additive `1.1.0` contract with exact paths and explicit authority boundaries

Consequences: one more contract version to maintain, but preserves `1.0.0` while enabling all clients through one authoritative API. Accepted.

## Validation requirement

Implementation must be accompanied by executable fixtures for:

- exact 47 `1.0.0` paths plus 18 organization paths and version advertisement;
- request/response schema alignment and opaque id validation;
- `202` intent acceptance, idempotent replay, and conflict behavior;
- stale AttentionRequest version rejection;
- attention answer/withdraw lifecycle;
- event cursor order, bounds, and unknown-cursor errors;
- no plaintext, private state, raw transcript, or local path leakage;
- Agent proposal audit view remains digest-only;
- paired Pagurus typed-client alignment after its own ADR.

## Consequences

The organization target now has an accepted publication boundary. No route in this contract is implemented by this ADR; `docs/openapi.yaml` and HTTP behavior remain unchanged until the implementation slice passes its fixtures.

> Public-contract direction only: this ADR accepts the versioned shape and gates implementation; it does not make any organization endpoint available.
