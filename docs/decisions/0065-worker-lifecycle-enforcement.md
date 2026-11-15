# Decision 0065: Worker lifecycle enforcement

Status: **accepted and implemented worker lifecycle enforcement**

Date: 2026-11-15 (Asia/Shanghai).

## Context

Three lifecycle gaps surfaced from live use:

1. `expiresAtSequence` was enforced only when creating a child delegation and when resuming an archived project. An expired delegation could still authorize a worker, start new work, and record reports — the grant effectively never expired.
2. Repeatedly failing workers stayed in the organization. Six near-identical briefers accumulated in one project, several permanently blocked.
3. Offboarding a worker revoked its delegation but left its Agent in the Agent list forever, so the list filled with dead identities.

## Decision

1. `assertActiveDelegation` runs on `authorize_worker`, `start_worker`, and `report_worker`. It requires the worker's delegation to exist, be `active`, and have `expiresAtSequence > lastSequence`. Expired or revoked delegations cannot exercise authority.
2. When collecting a failed worker outcome, the Boss retires the worker (`offboard_worker`) once that worker has two failed reports. Billing/quota errors (HTTP 401/402/403/429) are explicitly excluded — those are user-actionable and must not silently consume the worker.
3. `offboard_worker` now archives the Agent revision behind the worker. The Agent record and its revisions remain readable for audit; they simply leave the active list.
4. Existing per-project worker limits and the four-worker cap are unchanged.
5. No public path or schema changes.

## Options

### A. Only warn about expiry in the prompt

Consequences: authority would still outlive its grant; prompts cannot enforce permissions. Rejected.

### B. Retire a worker on the first failure

Consequences: one transient provider error destroys a worker and its context. Rejected.

### C. Enforce expiry in the domain, retire after two failures, archive on offboard

Consequences: authority matches its declared lifetime, retries stay meaningful, and the Agent list reflects reality. Accepted.

## Validation

- `tests/organization-contract.test.ts` asserts an expired delegation blocks `start_worker`.
- `tests/boss-mode-service.test.ts` asserts one failure does not retire a worker and that offboarding archives the Agent.
- `npm run check`, `npm test` (274), and `npm run build` pass.

## Consequences

Delegation authority now matches its declared lifetime, persistently failing workers stop consuming project capacity, and the Agent list stays meaningful. Expiry does not delete data; all history remains readable.
