# Decision 0036: Organization execution and reporting boundary

Status: **accepted internal implementation boundary; no public API contract changes**

Date: 2026-11-13 (Asia/Shanghai).

## Context

ADRs 0031–0033 accept the organization domain, dynamic delegation, bounded concurrency, structured reports, attention, archive, offboard, and resume direction. ADR 0035 adds private SQLite persistence inside the existing single owner. Conchbase `1.0.0` already owns Agent revisions, Task dispatch, durable WorkItems, platform work controls, capability records, and SecretHandles.

The organization layer still needs an executable seam between validated organization actions and the existing execution substrate. It must not become a second scheduler, a second Agent schema, a second writer of work state, or an excuse to expose an unversioned public API.

## Decision

1. `organization-execution.ts` is an internal, pure deterministic planner. It reads one organization snapshot and the current published work snapshots; it returns bounded commands and an ordered relay plan. It performs no I/O, opens no database, calls no provider, executes no tool, and does not mutate snapshots.
2. The planner may emit only commands already supported by published runtime contracts: ingest one WorkTrigger through the existing work contract, start work, stop work, complete work, and reconcile an interrupted assignment. It must not reinterpret `Task`, WorkItem, Assignment, or configuration state.
3. Dynamic worker creation remains two separate acts. The organization kernel records the bounded proposal and Delegation; only the existing Agent resource boundary may create an immutable Agent revision. Until that bridge exists, a proposed worker's `agentRevisionId` is an opaque reference and the planner starts no work. This ADR does not silently treat an organization `create_agent` action as an Agent revision.
4. Concurrency is enforced by bounded global and per-project active-work limits in the planner. User intent and open attention requests have priority: the planner emits no new launch while an open attention request exists. Routine progress remains in the project-side relay; only ready, blocked, failed, and attention facts may enter the primary-conversation relay, in one deterministic sequence.
5. Reports and attention remain structured kernel facts. The planner derives relay order only from those facts and opaque references; it never parses natural language and never exposes question, summary, or decision plaintext. It passes only bounded digests already stored by the organization kernel.
6. Application of planner commands belongs to the existing Runtime owner in a later implementation slice. Each command must preserve published expected-state conflict semantics and idempotency. This ADR accepts the deterministic planner and fixture only; it does not wire an HTTP route or start real model work.
7. The exact 47-path `1.0.0` OpenAPI contract remains frozen. Organization public contracts still require their own ADR under ADR 0034.

## Options

### A. Let the organization engine directly write work tables and Agent revisions

Consequences: fewer layers, but creates a second writer and can bypass accepted state machines and revision guarantees. Rejected.

### B. Treat every model action as an executable command

Consequences: fast dynamic behavior, but model prose or a prompt injection could start work, change authority, or flood the primary conversation. Rejected.

### C. Insert a pure planner that emits only published bounded commands

Consequences: adds one explicit seam, but preserves Runtime ownership, deterministic replay, existing state machines, and testability without a public contract change. Accepted.

## Validation

An executable fixture must prove:

- active-worker limits are bounded globally and per project;
- an open AttentionRequest prevents new launches;
- routine progress does not enter the primary-conversation relay;
- ready, blocked, failed, and attention facts relay in deterministic order;
- a proposed Agent is not started as an authorized Agent revision;
- commands use only existing work-control vocabulary and bounded identifiers;
- planner output contains no plaintext or unbounded payload;
- `docs/openapi.yaml` still has exactly 47 published paths.

## Consequences

The organization target gains a safe, inspectable bridge from domain facts to the existing execution substrate. Model work, Agent revision creation, durable command application, and public organization routes remain separate accepted slices.

> Internal implementation boundary only: this ADR accepts a pure planner, not connected organization execution or a new public API.
