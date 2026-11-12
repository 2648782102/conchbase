# Decision 0032: Dynamic Agent creation and bounded delegation direction

Status: **accepted product direction; development boundary; no public API contract changes**

Date: 2026-11-13 (Asia/Shanghai).

## Context

ADR 0030 accepts runtime-created worker Agents without a template requirement. ADR 0031 establishes the organization domain boundary. The remaining security-critical question is how a model-created Agent definition becomes an authorized worker and how that worker may recursively create others.

Conchbase already treats Agent revisions as immutable and binds tasks to pinned revisions. The organization layer must extend that boundary to model proposals without allowing a model, Skill, plugin, prompt, or client to grant itself capability.

## Decision

### 1. Model proposals are not Agent revisions

A model may emit a structured `create_agent` proposal. The proposal is untrusted input. It becomes an Agent revision only after the Runtime validates it.

Validation must cover at least:

- exact schema and absence of unknown fields;
- bounded display name and instructions;
- opaque capability and SecretHandle references;
- provider-neutral model preference;
- requested scope, budget, TTL, and delegation depth;
- parent identity, parent Mandate, and current policy version;
- rejection of plaintext, paths, URLs, credentials, and secret-like values.

### 2. Dynamic workers use existing immutable revisions

When accepted, a worker definition becomes an immutable Agent revision in the existing Agent identity model. The revision records its creator, organization context, parent Delegation, and policy version as bounded internal metadata.

Changing a worker definition creates a new revision. Running WorkItems remain pinned to the revision they started with. Archiving a worker never deletes its revision history.

### 3. Delegation only contracts authority

Every worker must be created under a Delegation. A child Delegation may request authority only within the parent's effective authority:

- scope subset;
- capability subset;
- allowed operation subset;
- remaining turn/token/time budget;
- lower or equal recursion depth;
- equal or shorter TTL;
- no access to parent-only reports or threads.

The Runtime clamps or rejects escalation. It never enriches a child from ambient configuration. Existing runtime-wide policy and capability records remain the outer boundary.

### 4. Recruiting is a capability

There is no HR role type. `can_delegate` is a bounded capability that may be present on any Agent revision if the parent authorization allows it. A worker without it cannot propose sub-agents.

Recursion must be finite. A later contract must define maximum depth, accounting rules, and what happens when a parent expires while children remain active.

### 5. Templates are deferred

No pre-approved template registry is required. A successful Runtime-created revision may later be promoted to a template by a separate ADR. The current `/v1/agents` resource does not imply a template system.

### 6. Audit boundary

Every accepted or rejected proposal must produce a bounded structured event with reasons. Reasons must be codes or bounded scalars, not raw model transcripts. Rejection events must not leak plaintext or raw rejected payloads.

## Options

### A. Treat model-generated Agent JSON as authoritative

Consequences: fastest dynamic behavior, but a prompt injection or careless model directly becomes capability escalation. Rejected.

### B. Require pre-approved templates for every worker

Consequences: easier security model, but contradicts the accepted direction that users author only the root Agent and workers are defined in conversation. Deferred as an optional later optimization, not a prerequisite.

### C. Validate model proposals inside the Runtime and persist immutable revisions

Consequences: preserves dynamic organization while retaining the Runtime as authorization authority. Requires explicit schemas, budgets, and fixtures. Accepted as a direction.

## Validation requirement

Future implementation must prove:

- valid proposal → immutable Agent revision + Delegation + WorkItem binding;
- unknown fields and secret-like values rejected;
- scope/capability/budget/depth/TTL escalation rejected or clamped by explicit rules;
- child inherits only parent authority;
- running WorkItem pins its Agent revision;
- template registry absence;
- audit events contain no plaintext or raw proposals;
- recursive delegation terminates.

## Consequences

The core dynamic behavior now has an accepted security shape: models define, Runtime authorizes, revisions are immutable, and delegation only contracts. No implementation contract, API route, or schema change is accepted here.

> Product direction and development boundary only: this ADR does not create Agent revisions or delegate real work.
