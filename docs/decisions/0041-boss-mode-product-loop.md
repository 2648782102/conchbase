# Decision 0041: Boss-mode product loop completion

Status: **accepted and implemented final Boss-mode product loop**

Date: 2026-11-14 (Asia/Shanghai).

## Context

ADR 0040 introduced an untrusted intent parser and a Runtime-owned bridge, but the implementation did not satisfy the complete product loop. It used a hardcoded model id, created WorkItems without running worker tasks, returned organization events from the published session view, exposed inconsistent runtime discovery, kept process-local idempotency, and described incomplete behavior as complete. A follow-up audit found those gaps by reading the target specification, OpenAPI, executable fixtures, and the default CLI path.

The target in `docs/ORGANIZATION_RUNTIME_TARGET.zh-CN.md` requires one primary conversation, dynamic Runtime-validated workers, bounded Delegation, concurrent work, structured Report/Attention, archive/offboard/resume, and a deterministic dual-repository fixture with a fake provider, multiple projects, one manual answer, and one archive/resume path.

## Decision

1. Boss mode becomes a Runtime-owned asynchronous loop. A user submits bounded text once; the Runtime records a digest-only intent, parses untrusted structured actions, validates and commits them, creates real immutable Agent revisions, starts Agent-backed Tasks and durable WorkItems, waits for worker results, commits structured reports and attention requests, and exposes only published facts.
2. Intent identity is deterministic from `idempotencyKey`; body identity is a digest. `record_intent` is a private organization action with only bounded digests and counts. Replaying the same key and body reads existing organization facts and performs no new actions; reusing a key with a different body returns a conflict. Intent records survive process restart because they are organization actions in the existing SQLite action log.
3. Dynamic worker creation resolves a provider-neutral model through the existing provider catalog. The Runtime supplies bounded instruction text, validates the model through `TaskService`, creates one immutable Agent revision, authorizes the worker, creates one durable WorkTrigger and one Agent-backed Task, and starts them when no AttentionRequest is open. A model-proposed capability, scope, model, or instruction value is never authority by itself.
4. Worker results are explicit. Successful output produces a digest-only `report_worker` with state `ready`; output containing a structured attention marker produces `report_worker` with state `attention` plus `request_attention`; failure or cancellation produces a structured `failed`/`blocked` report. Primary relays come only from these organization events through the planner, never from raw provider text.
5. Open AttentionRequests block new autonomous launches. Answering an AttentionRequest commits the decision, reopens the affected worker through a structured state transition, starts queued work, and creates a fresh Task/WorkItem rather than replaying the old model call. Withdrawal only records the decision.
6. Archive prepares active workers by committing an ended report, offboarding each worker, revoking Delegations, quieting the project, and then archiving it. Resume revalidates a project Delegation, reactivates the Delegation, moves offboarded workers to idle, and creates a fresh Task/WorkItem. Old events, reports, outputs, and decisions are preserved.
7. Parent/child `create_agent` actions remain topology-neutral data, not fixed roles. The organization kernel continues to enforce scope/capability subset, depth, and TTL. A fixture covers both accepted bounded delegation and rejected over-broad delegation.
8. Worker-to-work identity is persisted in `organization.worker_started` event data as bounded `taskId`, `workItemId`, and `agentId` references. The execution planner uses that mapping instead of guessing `work_${worker.id}`. On restart, the Boss-mode service rebuilds its mappings from organization events and resumes unfinished Tasks through the existing TaskService recovery boundary.
9. The published `1.1.0` contract is corrected without adding paths: `RuntimeStatus.organizationContract` and `organizationPaths` are optional discovery fields; `/v1/organization/session` omits raw events and publishes AttentionRequests with `expectedVersion`; `OrganizationIntentResult.intentId` stays a 24-hex opaque id; `/v1/organization/events` resolves cursors against the full durable event sequence; `/v1/organization/work-items` uses persisted work-item identity. Pagurus consumes these fields through explicit typed validators and derives expected sequence from event pages.
10. Error behavior is explicit. Missing model availability returns an unavailable Runtime error, malformed model output or secret-like input returns a bounded validation error, stale expected versions and idempotency conflicts return `409`, and missing resources return `404`. CLI `boss` and `organization` commands wait for the Runtime-owned loop, print bounded results, and set a non-zero exit code on failures.

## Options

### A. Keep the ADR 0040 bridge and add UI polish

Consequences: preserves passing tests but leaves a demo state machine rather than a usable agent organization. Rejected.

### B. Add new public lifecycle endpoints for every boss action

Consequences: makes clients orchestrators and encourages a second authority. Rejected.

### C. Keep one primary intent endpoint and put the full loop behind Runtime ownership

Consequences: requires persisted action data, asynchronous task handling, recovery, and stronger fixtures, but satisfies the target with one public client surface. Accepted.

## Validation

An executable fixture must prove:

- deterministic and OpenAI-compatible parsers use Runtime-resolved model references and reject secret-like or out-of-schema output;
- one primary conversation creates multiple projects and concurrent workers with real Agent Tasks and durable WorkItems;
- worker outputs produce digest-only structured reports, attention requests, and ordered relays;
- open attention blocks launches; answering attention starts queued work and creates fresh assignments;
- archive performs report/offboard/quiet/archive; resume revalidates Delegation and creates fresh work;
- parent/child Delegation enforces subset, depth, and TTL;
- repeated intent keys replay across a rebuilt service and conflicting bodies fail;
- session responses omit events, attention views expose `expectedVersion`, and runtime discovery is optional;
- a dual-repository fixture uses Pagurus typed clients over live loopback HTTP with a credential-free fake provider;
- both repositories pass `npm run check`, `npm test`, and `npm run build`.

## Consequences

Boss mode becomes a complete, usable local-first product loop under the existing execution authority. Real tool execution, external Sources, cross-process secret custody, production remote pairing, and generated client types remain outside this decision.

> Final product-loop boundary: this ADR accepts the completed Runtime behavior and requires the named executable fixtures before status documents may call the target complete.
