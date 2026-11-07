# Decision 0002: Task lifecycle model (proposal)

Status: **proposed, not accepted as a public contract**

Accepted direction: [ADR 0010](0010-first-real-model-slice.md) accepts this state machine for the first real-model slice and adds a terminal `interrupted` state. The public task routes and their response shapes are defined by `docs/openapi.yaml` and implemented in that slice; this record remains a proposal for the broader unresolved lifecycle contract.

## Context

`AGENTS.md` and `docs/AI_HANDOFF.md` require task lifecycle, cancellation, event ordering/replay, and configuration revision pinning to be decided through an ADR before a public task API is exposed. The runtime currently has read-only status endpoints and no agent loop.

An internal deterministic core now exists under `src/runtime/` so transitions can be tested before HTTP, persistence, or provider choices are locked. These modules are not imported by `src/http/` and do not change `docs/openapi.yaml`.

## Options

### A. Minimal explicit state machine (recommended)

States: `queued`, `running`, `waiting_approval`, `cancelling`, `succeeded`, `failed`, `cancelled`.

- A task is created in `queued` and pinned to one configuration revision ID.
- `running` can enter `waiting_approval`, `cancelling`, `succeeded`, or `failed`.
- `cancelling` is a committed intent; only `cancelled` follows it.
- Terminal states reject further transitions.
- Every transition maps to a named domain event with a monotonic per-log sequence.

Consequences: deterministic and easy for a weaker model to test; leaves provider, persistence, and API envelopes open. It does not yet define distributed recovery or cross-process event ordering.

### B. Provider-driven states

Mirror a selected provider SDK's run states.

Consequences: less translation initially, but the public contract becomes provider-coupled and cancellation/approval semantics change when the adapter changes. Rejected because Conchbase owns task and permission state.

### C. Event-sourced state only

Store events and derive state by replay.

Consequences: strong auditability, but premature without a persistence schema, snapshot policy, and validation of concurrent writers. Keep ordered events as a required property, defer full event sourcing.

## Recommendation

Adopt option A as the internal behavior under test. Keep it a proposal for the public contract until product direction approves task IDs, event envelopes, error/retry semantics, and persistence. Do not add task routes or advertise task execution capability yet.

## Validation

`tests/task-lifecycle.test.ts`, `tests/event-log.test.ts`, and `tests/configuration-revision.test.ts` cover legal transitions, terminal rejection, cancellation, config pinning, stable event IDs, replay without duplication, and immutable revision history. `tests/policy-gate.test.ts` proves denied, unapproved, and revoked tools do not execute. `tests/task-runner.test.ts` uses an internal scripted model adapter to prove success, failure, and cancellation terminal paths without executing a later tool; it does not call a real provider.
