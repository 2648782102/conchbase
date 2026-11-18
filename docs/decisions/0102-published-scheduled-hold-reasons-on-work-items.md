# Decision 0102: Published scheduled hold reasons on work items

Status: **accepted and implemented**

Date: 2026-11-18 (Asia/Shanghai).

## Context

ADR 0101 made the coordinator admit planned `start_work` commands through the global scheduler and return visible hold decisions. That visibility was ephemeral: a client that refreshed organization state after the Boss turn could see an `authorized` worker but not why its work had not started.

A new public route would widen the frozen organization contract, and a new organization action just to log "held" would duplicate the worker state machine. The Runtime already has enough facts to derive the answer: authorized workers, active projects, and current scheduler capacity.

## Decision

1. Add a pure `projectWorkHolds(snapshot, limits)` projection. It treats authorized/idle workers on active/resumed projects as queued work, counts running workers as capacity consumers, and returns the scheduler's hold reason per derived work item.
2. `GET /v1/organization/work-items` adds an optional `heldBy` field (`global-limit` or `project-limit`) to a published work item. No path or action is added; this is an additive response field documented in OpenAPI.
3. A hold remains a derived fact, not durable state. The authoritative facts are the worker's state and current scheduler limits; replaying that derivation after restart is deterministic.
4. Running workers are never reported as held, and a held worker keeps its existing organization state. The projection changes no execution or authorization.
5. The default per-project capacity of 2 remains the published behavior; operator overrides apply to the projection exactly as they apply to admission.

## Options

### A. Add a `work_held` organization action/event

Consequences: a scheduling detail becomes part of the public action vocabulary and must be deduplicated across reconciles. Rejected.

### B. Add a dedicated hold read route

Consequences: another path to document, guard, and keep in sync with work-item state. Rejected for a field that belongs to a work item.

### C. Derive the reason on the existing published work-item list

Consequences: one authoritative derivation, no new state, no new path. Accepted.

## Validation

- Fixtures cover project-capacity holds, running workers consuming capacity, custom limits, and read-only deterministic projection.
- The HTTP fixture asserts the third authorized worker receives `heldBy: "project-limit"` while the first two do not.
