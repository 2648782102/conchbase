# Decision 0030: Organization Runtime product direction

Status: **accepted product direction; development boundary; no public API contract changes**

Date: 2026-11-13 (Asia/Shanghai).

## Context

Conchbase `1.0.0` is a closed local-first platform. It owns the agent loop, stable Agent identities and immutable revisions, durable work, task state, policy/capability configuration, and private persistence. Pagurus is a client that submits intent and reads published state through the frozen 47-path Runtime API. ADR 0022 accepts a durable, event-driven, topology-neutral work direction, ADR 0024 implements the historical first durable-work slice, and ADR 0025 implements the final local-first `1.0.0` contract. ADR 0026 closes the AI handoff boundary and requires every later product expansion to pass through an accepted decision before implementation.

Users nevertheless want a different interaction shape from the current task-centric client model. They want one durable primary conversation with one entry Agent, while multiple pieces of work proceed concurrently in the background. The user should not have to open, name, or supervise many sessions. The entry Agent should recognize projects from the primary conversation, define bounded workers, delegate work to them, and report back only when a result, decision, or failure deserves attention.

The initial proposal used organizational language such as boss Agent, HR Agent, employee Agent, hiring, and firing. Those names are useful for explaining the product, but they must not become scheduling rules or a fixed role taxonomy. The existing product invariant is that Agent composition remains topology-neutral: layered arrangements and specialized roles are examples, not schemas, defaults, or scheduling policy.

DeepSeek's `dsh-superagent-prototype` is a relevant research reference, not an implementation target. Its useful ideas are the durable distinction between triggers, threads, work, authorization, assignment, and subscription; versioned policy; quiet reporting; structured state instead of free-text classification; a single domain writer; bounded worker concurrency; and a panel that prioritizes work needing a person. Its concrete GitHub/Feishu coding workflow and role presets are not adopted.

This ADR accepts the direction and development boundary for that product shape. It does not add routes, schemas, events, migrations, endpoints, UI surfaces, or runtime behavior. It does not reopen `1.0.0`, change the frozen 47-path contract, or make a deferred capability implemented behavior.

## Product direction

Conchbase should add an **Organization Runtime** capability layer on top of its existing execution authority. It must not become a second runtime or replace the current task/work kernel. The user-facing center is one durable primary conversation with a default entry Agent, referred to in product language as the boss Agent. Internally, the Runtime owns the structure that makes the conversation useful: projects, delegations, Agent definitions created during the conversation, bounded work, structured reports, and archive/resume history.

The intended user experience is:

1. The user talks to one primary Agent and does not need to manage a session per project.
2. The entry Agent recognizes that the conversation contains one or more ongoing projects.
3. The entry Agent, or an Agent it has authorized to recruit, proposes another Agent definition for a bounded purpose.
4. The Runtime validates and records the definition, authorization, and delegation before any execution begins.
5. Workers execute independently and concurrently within Runtime-owned limits.
6. The primary conversation stays quiet during routine progress. It receives concise results, concrete questions, failures, and meaningful summaries.
7. When a project becomes idle or its work reaches a reporting boundary, the Runtime requests a report from the entry Agent or an authorized reporting Agent, persists the structured result, presents a concise summary, preserves the project history in a separate thread, and ends the active worker authorization without deleting history.
8. Later, a user message about that project may resume the archived work after its authorization is revalidated.

This is a single-entry interaction model, not a single-agent execution model. The user sees one conversation; the Runtime may maintain many bounded execution contexts behind it.

## Accepted direction

### 1. One user-authored root Agent

The boss Agent is the only Agent that a user must define in order to use this model. Its user-facing configuration expresses goals, working style, reporting style, authorization preferences, recruitment behavior, budget preferences, project-idle behavior, and escalation expectations.

The Runtime may represent parts of that configuration as versioned internal structures such as an organization charter, capability boundary, or policy revision. Those structures are implementation details unless a later ADR publishes them. They must not create a second user-facing Agent schema.

The boss Agent is a default coordinator relationship, not a universal superuser. It acts only through Runtime-validated structured actions and remains bounded by Runtime policy, configuration, and capability records.

### 2. Runtime-created Agents instead of a required template library

For the initial version, there is no required Agent template registry and no requirement that a worker be instantiated from a pre-approved template. The boss Agent or an authorized recruiting Agent may propose a worker Agent definition during the conversation. The Runtime validates that proposal and records the accepted definition as an immutable Agent revision using the existing Agent identity model.

The intended flow is conceptual:

```text
primary conversation
  -> entry Agent understands intent
  -> structured create_agent / delegate / report / offboard / archive action
  -> Runtime validation and authorization
  -> immutable Agent revision and Delegation record
  -> WorkItem and Assignment
  -> structured reports and durable events
```

Model-generated text never changes Runtime state directly. A proposed Agent definition, capability request, budget, or delegate permission becomes effective only after the Runtime validates it against the parent authorization and published policy.

Agent templates are explicitly deferred. If successful runtime-created Agent revisions later prove reusable, a separate ADR may define how they are promoted into templates. Templates are an optional crystallization of successful history, not a prerequisite for dynamic organization, and are not implied by the current Agent resource.

### 3. Recruiting is a bounded capability, not a role enum

HR Agent is a product metaphor for an Agent that has been granted a bounded recruiting capability. It is not a fixed role, node type, or schema enum. Any Agent revision may be given that capability if its authorization allows it, and any Agent without it cannot propose sub-agents.

Recruiting rights can be inherited only by contraction. A proposed child may not receive capabilities, scope, budget, recursion depth, or lifetime that exceed its parent's effective authorization. A later implementation contract must define how the Runtime enforces boundaries for:

- project or work scope;
- allowed operations and capability references;
- maximum recursion depth;
- turn, token, time, or equivalent execution budget;
- time-to-live and expiry;
- ability to create further delegations;
- access to reports and project threads.

The exact representation, limit names, and enforcement points are not accepted by this ADR. They require a later implementation contract.

### 4. Projects and work are durable and separate from conversation text

The primary conversation remains a source of user intent and context, but it is not the authoritative store of project state. Structured Runtime state must distinguish at least the following concepts, though their final names and fields are not fixed here:

- a primary conversation or boss session;
- a project or durable work theme derived from that conversation;
- a delegation relationship between authorizer and worker;
- an Agent revision created for a bounded purpose;
- an authorization or mandate that records scope and limits;
- a work item and one or more assignments;
- an independent project execution/reporting thread;
- structured reports and attention requests;
- organization events that record lifecycle changes.

Natural-language summaries are for people and models. They are never the sole source for status, ownership, completion, failure, waiting-on-user, or authorization decisions. Those facts must be represented structurally before they are reported.

### 5. The existing durable work kernel remains the execution substrate

Organization work should reuse the existing work item, assignment, mandate, outbox, receipt, event, start/stop/complete, and recovery boundaries wherever they fit. The Organization Runtime adds structure around work: project identity, delegation, dynamic Agent creation, reporting policy, concurrency governance, and archive/resume lifecycle.

This ADR does not accept a second private scheduler, a competing execution store, a canonical topology, or a parallel Agent definition schema. A later implementation decision must explain precisely where organization state lives, which component writes it, and how it relates to `work-contract.ts`, `work-store.ts`, and `platform-store.ts`.

### 6. Concurrency is bounded and user interaction keeps priority

Multiple projects and workers may proceed concurrently. Concurrency must be governed by Runtime policy rather than by the language model alone. A later contract may define global and narrower limits, fair scheduling, and controlled admission of new work.

User messages, explicit stop requests, and answers to attention requests must not be starved by queued background work. A later contract may implement this through reserved slots, priority lanes, or another mechanism, but the product principle is accepted now: new autonomous work must not prevent the user from continuing the primary conversation or stopping existing work.

Reports entering the primary conversation must be serialized through a Runtime-owned path. Concurrent workers must not write directly into the primary conversation or interleave fragments in a confusing order.

### 7. Quiet by default, precise when speaking

The product should minimize the attention it costs. The primary conversation should receive messages when:

- a result is ready;
- a concrete decision or answer is required;
- work is blocked or failed;
- a meaningful project summary or handoff is available;
- the user explicitly asks for status.

Routine progress belongs in project threads and structured state. A report must honestly distinguish draft, progress, waiting, ready, blocked, failed, and ended states, or a later contract's equivalent vocabulary. Waiting-on-human must be a structured fact, not inferred from free text.

The Pagurus panel should follow the same principle: first show what needs a person, then system health, then history. Healthy background activity should not compete with actionable work for attention.

### 8. Offboarding is archival, not deletion

Ending a worker must revoke its active authorization, cancel or interrupt its running assignments according to a later state contract, and preserve its events, reports, outputs, decisions, and project thread. The Runtime must not delete history merely because an Agent is no longer active.

Idle aggregation should be policy-driven. The entry Agent may recommend a project summary or closure, but it should not unilaterally define retention rules. A later ADR may define how idle detection, report generation, thread separation, authorization revocation, and resume revalidation interact.

Resuming archived work requires revalidation. The original scope, capabilities, policy version, and work state may have changed; the Runtime must decide whether archived work can resume under current rules.

## Boundaries and non-goals

This ADR accepts a direction only. It does not accept:

- new or changed public API paths, schemas, event names, or configuration documents;
- a database migration, new persistence owner, or change to `user_version`;
- executable tools, MCP lifecycle, Skill/plugin installation, or generic secret resolution;
- real external Sources or external side effects;
- generated clients or a second Runtime schema in Pagurus;
- a fixed boss/HR/employee role enum or canonical agent topology;
- unrestricted model-created Agents, unlimited recursion, or self-expiring authority by prompt alone;
- removal or weakening of SecretHandle, tool policy, loopback binding, or paired-client boundaries;
- a claim that any part of this direction is implemented.

Provider integrations remain replaceable adapters. A local Magpie compatibility path may be useful for experiments, but no Agent definition or Organization Runtime contract may depend on a particular provider's model catalog, session format, or role capabilities.

The current `Task` resource and the published WorkItem contract remain unchanged. Organization concepts introduced by this direction must not be silently mapped onto `Task` or `WorkItem` semantics that cannot represent them.

## Options considered

### A. Keep the task-centric `1.0.0` interaction model

Consequences: preserves the closed contract and avoids new complexity, but forces users to open and coordinate many sessions and leaves the desired single-entry experience unaddressed. Rejected as a product direction.

### B. Build a separate super-agent repository and treat Conchbase as a library

Consequences: allows unconstrained experimentation, but splits execution authority, Agent identity, persistence, authorization, and client contracts. It risks creating a second Runtime and a second source of truth. Rejected.

### C. Add a fixed boss/HR/employee role hierarchy to the current public schema

Consequences: easy to explain, but hardcodes a topology, conflicts with the accepted topology-neutral invariant, and turns illustrative metaphors into long-lived API contracts. Rejected.

### D. Add an Organization Runtime layer in Conchbase with a paired Pagurus surface

Consequences: preserves Conchbase as the single execution authority, reuses durable work and Agent revision boundaries, keeps clients replaceable, and allows dynamic Agent creation without a template prerequisite. It requires new ADRs for concrete contracts, state, authorization, security, and UI. Accepted.

## Relationship to DeepSeek's prototype

The following concepts are useful references: trigger intake separated from evaluation; durable work with an explicit mandate; per-work assignment; subscription-based continuation; structured report states; a single domain writer; durable side effects with retry; worker slots; versioned policy; quiet conversation behavior; and a panel organized around human attention, health, and history.

The following are not adopted: GitHub/Feishu-specific Source implementations, coding-worktree assumptions, DeepSeek Harness session internals, fixed orchestrator/worker presets, auto-merge rules, and any claim that the research prototype's safety or recovery model is production-ready.

DeepSeek's core attention principle is accepted as a product guideline: take little human attention and give useful value. In Conchbase, that guideline remains subordinate to the stronger local invariants around authorization, SecretHandle protection, tool policy, and Runtime authority.

## Development sequence implied by this ADR

This ADR permits later work to prepare designs and documentation. It does not make any slice directly executable and does not change `docs/AI_TASK_QUEUE.md` or `PROJECT_STATUS.json`. A later implementation must proceed through separately accepted decisions covering, at minimum:

1. the organization domain model, state ownership, and lifecycle;
2. the structured action boundary between model output and Runtime commands;
3. Agent creation, delegation, authorization inheritance, budgets, TTL, and recursion limits;
4. concurrency, reporting, primary-conversation relay, and recovery semantics;
5. persistence and migration ownership;
6. versioned public contracts and paired Pagurus surfaces, if exposed;
7. deterministic fixtures for delegation, offboard/archive, resume, concurrency priority, and quiet reporting.

Slices may be combined when they cannot be safely separated, but each accepted contract must state what is implemented and what remains deferred. The frozen `1.0.0` path set stays intact until an explicit versioned public-contract ADR changes it.

## Validation of this decision

- The frozen 47-path OpenAPI contract, `work contract version 2`, and `user_version = 3` remain unchanged.
- No implementation claim is added to `PROJECT_STATUS.json` by this ADR.
- A paired Pagurus ADR records the client-side direction without introducing a second schema or UI route.
- Repository guardrails must continue to distinguish accepted direction from implemented behavior.
- Later coding models must still read `AGENTS.md`, `docs/AI_HANDOFF.md`, `docs/PROJECT_STATUS.json`, and `docs/OBJECTIVE_MODE.zh-CN.md` before selecting work.

## Consequences

Conchbase now has an accepted product direction for the single-entry, dynamically organized agent experience without prematurely freezing its API. This gives later models a clear target to design against: one user-authored root Agent, Runtime-validated worker revisions, bounded recruiting, durable work, quiet reporting, and archival lifecycle.

The cost is an explicit gate before code. The direction is intentionally ambitious but not vague about invariants: the Runtime remains authoritative, topology remains neutral, authorization only contracts through delegation, and model text never becomes permission. Concrete objects, events, routes, storage, and UI are intentionally deferred so they can be designed with the same determinism as the `1.0.0` platform.

> Product direction and development boundary only: this ADR does not change the public API, implement Organization Runtime behavior, or make any deferred capability available to clients.
