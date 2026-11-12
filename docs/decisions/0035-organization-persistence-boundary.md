# Decision 0035: Organization persistence boundary

Status: **accepted internal implementation boundary; no public API contract changes**

Date: 2026-11-13 (Asia/Shanghai).

## Context

ADRs 0031–0033 accept the organization domain, dynamic Agent delegation, and concurrency/reporting/archive direction. The pure `organization-contract.ts` kernel and in-memory `organization-store.ts` are implemented and validated. They do not survive process restart and are not connected to the Runtime's single SQLite owner.

ADR 0025 freezes the local-first `1.0.0` contract at `user_version = 3`. ADR 0030 explicitly says the organization direction does not accept a database migration or change to `user_version`. To continue executing the long-range target without silently violating that gate, persistence requires its own accepted boundary ADR.

## Decision

1. Organization state may be persisted in the existing Conchbase private SQLite database through the same `DatabaseSync` handle owned by `SqliteTaskStore`. No second database, private file, client-side state, or second owner is accepted.
2. The migration is additive, transactional, and versioned as `PRAGMA user_version = 4`. It preserves all `user_version = 3` task, event, Agent, configuration, tool-request, work, platform, and SecretHandle rows and pointers. Failure rolls back the whole migration.
3. The initial organization schema stores a single primary conversation snapshot plus normalized projects, delegations, workers, reports, attention requests, and immutable organization events. It must not store plaintext SecretHandle values, raw model transcripts, provider sessions, filesystem paths, or unbounded payloads.
4. `SqliteOrganizationStore` implements the same internal `OrganizationStore` port as `InMemoryOrganizationStore`. It commits one accepted action and its organization event in one transaction and rejects stale expected sequences under that transaction.
5. The store remains internal. It is not exposed through HTTP, CLI, Pagurus, or a generated client by this ADR. The 47-path `1.0.0` OpenAPI contract remains frozen and `docs/openapi.yaml` is unchanged.
6. Restart recovery may rebuild the immutable snapshot from persisted rows and events. It must not resume a model call, execute a WorkItem, or imply successful completion of durable work.
7. The existing single-owner lock, loopback binding, capability gates, and no-client-private-access invariants remain unchanged.

## Options

### A. Keep organization state in memory until the public API exists

Consequences: no migration, but primary-conversation state disappears on restart and later API work would have no authoritative state. Rejected for the long-range target.

### B. Open a second SQLite database for organization state

Consequences: isolates tables, but creates a second owner and weakens the single execution-authority boundary. Rejected.

### C. Add an additive migration to the existing single owner

Consequences: changes `user_version` from 3 to 4, but preserves one owner, one transaction boundary, and the existing persistence model. Accepted.

## Validation

An executable fixture must prove:

- a `user_version = 3` database with legacy rows migrates to `user_version = 4` without data loss;
- one accepted organization action survives close and reopen;
- stale expected sequences are rejected;
- organization events replay into one coherent snapshot;
- a second simultaneous owner remains rejected;
- no plaintext or unbounded payload is persisted;
- the 47-path OpenAPI and published contract version remain unchanged.

## Consequences

The organization target can gain durable state without creating a second runtime or silently changing the frozen `1.0.0` platform contract. This ADR accepts only internal persistence; execution, model routing, and public API remain deferred to their own decisions.

> Internal implementation boundary only: this ADR changes private database schema version but does not change public API, client contract, or provider behavior.
