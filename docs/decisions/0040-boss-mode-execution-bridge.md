# Decision 0040: Boss-mode execution bridge

Status: **accepted and implemented Runtime-service execution boundary**

Date: 2026-11-13 (Asia/Shanghai).

## Context

ADRs 0030–0039 accept the Organization Runtime target, kernel, private persistence, bounded planner, digest-only dynamic-Agent projection, coordinator seam, and additive `1.1.0` public contract. The Runtime can accept bounded intents and publish organization facts, but an intent still becomes only a deterministic `open_project` action. It does not call a model, create a real Agent revision from a dynamic proposal, bind organization workers to WorkItems, or let worker results return as structured reports.

The final usable Boss mode needs a single primary-conversation entry point. The user states intent in prose; a replaceable structured model adapter proposes bounded organization actions; the Runtime validates and commits them; authorized workers execute through the existing Agent-task and durable-work substrate; results return to the primary conversation as structured reports and attention requests.

## Decision

1. `organization-intent-parser.ts` is the internal untrusted-output boundary. It accepts a bounded prompt and returns either zero or more accepted organization actions plus a bounded relay text, or a structured rejection. It must be provider-neutral and use a replaceable structured adapter. Default offline fixtures use a deterministic adapter; a real OpenAI-compatible adapter may be injected as an implementation of the same boundary.
2. Prompt injection and model prose are never authority. Every proposed action passes `parseOrganizationAction`; model-supplied capability, scope, model, and instruction values remain proposals. The Runtime applies Delegation subset rules, model catalog validation, digest-only secret rejection, and expected-sequence conflict checks through the authoritative organization store.
3. A Runtime-owned `BossModeService` is the only component allowed to connect organization facts to execution. It composes the organization store, TaskService's Agent validation/store boundary, durable work intake, platform work controls, and the organization coordinator. It owns no separate database, no second Agent schema, and no tool executor.
4. Dynamic worker creation is a two-phase bridge. An accepted `create_agent` action first becomes a digest-only proposal under ADR 0037. The Runtime service then supplies bounded instruction content, validates the provider-neutral model through the existing Agent boundary, creates an immutable Agent revision, and records the resulting opaque revision reference in bounded service state. A proposal alone never starts work.
5. Worker execution reuses existing Agent-backed tasks. Each running organization worker with a real Agent revision and accepted Delegation may be bound to one WorkItem through the accepted durable-work trigger contract. Worker progress remains digest-only; no tool execution or external write is introduced by this decision.
6. Structured reports are produced by bounded Runtime operations or by an injected report adapter and must be validated as organization actions before commit. Reports, attention requests, blocked/failed facts, and completed work produce ordered primary relays through the coordinator. Routine progress never enters the primary relay.
7. Intent submission is asynchronous. A `202` result means the Runtime accepted the text and queued parsing/commitment, not that the model's desired state already exists. Clients read published organization state and events for truth.
8. Failure is explicit and retryable. Model refusal, malformed output, rejected action, model-catalog failure, work-control conflict, and callback failure produce bounded service results. An already committed organization action is never rolled back by a later execution failure; explicit reconcile may retry.
9. The additive `1.1.0` public contract remains the client surface. New server-internal state stays private. Any public endpoint or response field change requires a new accepted contract ADR;Pagurus consumes only published facts.

## Options

### A. Let the model submit organization actions directly to the public API

Consequences: simple, but prompt injection becomes authority and the API becomes an unauthenticated scheduler. Rejected.

### B. Keep the deterministic `open_project` mapping and call it Boss mode

Consequences: safe but not usable; users cannot create workers, projects, or reports from one primary conversation. Rejected.

### C. Add a Runtime-owned bridge with untrusted parsing and authoritative validation/execution

Consequences: more components and fixtures, but preserves the product goal and every accepted safety boundary. Accepted.

## Validation

An executable fixture must prove:

- a prose intent can produce multiple bounded organization actions through a deterministic structured adapter;
- malformed, secret-like, over-broad, and stale proposed actions are rejected before commit;
- `create_agent` becomes a real immutable Agent revision only after Runtime validation;
- a proposed worker without a validated revision never starts work;
- an authorized worker binds to accepted durable WorkItem state using published controls;
- reports, attention, blockage, and completion produce ordered structured relays;
- open attention blocks new autonomous launches;
- repeated intent submissions are idempotent;
- no plaintext, private path, generic secret resolver, canonical topology, or role enum is introduced;
- one primary conversation fixture drives multiple projects through submit, execute, report, archive, and resume.

## Consequences

Boss mode becomes an executable Runtime capability rather than a document-only target. Model output remains untrusted; Conchbase remains the sole execution authority; Pagurus and CLI remain clients of the published contract.

> Runtime-service execution boundary: this ADR accepts the bridge architecture and requires fixtures before the capability is described as implemented.
