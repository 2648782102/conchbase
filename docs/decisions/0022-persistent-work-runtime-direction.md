# Decision 0022: Persistent, event-driven personal Agent Runtime direction

Status: **accepted product and architecture direction; no public API contract changes**

Date: 2026-11-11 (Asia/Shanghai).

## Context

Conchbase `0.8.0` owns Agent identities, immutable revisions, pinned single-turn tasks, durable progress events, and a versioned Runtime API. Pagurus manages those Agents and inspects tasks. This is a sound execution-authority kernel, but the current product reads as a configuration surface around bounded one-shot tasks. It does not yet own a long-lived work identity across client sessions, source events, execution attempts, and externally observable delivery evidence.

The article *Super-agent 设计探索：迈向更自主的 Agent 系统* argues that Session should become an implementation detail while work identity, authorization, event history, and delivery state become product state. The public `dsh-superagent-prototype` is research code, not an official product specification; its domain and authorization documents nevertheless provide useful evidence for separating context subscriptions from authority. Its `Mandate`, `Ticket`, `Assignment`, and `Channel` concepts show why a Model Session must not be the source of truth. The article's synthetic experiments measure scheduling, not real task-solving capability. Its cloud, Watchdog, speculative-execution, and multi-channel claims remain open research directions.

This decision records product direction only. It does not change `docs/openapi.yaml`, add a route, create a schema, execute a tool, bind beyond loopback, or adopt DeepSeek Harness or any DeepSeek model as a dependency.

## Product definition

Conchbase becomes a **local-first, persistent, event-driven, topology-neutral personal Agent Runtime**. A user-managed Agent remains a versioned, independently customizable definition, not a conversation. Router/Worker, a layered multi-role arrangement, and every other coordination shape remain non-normative configurations. Conchbase owns the agent loop, stable work identity, policy and approval authority, durable state, provider adapters, and delivery evidence. CLI, Pagurus, IDEs, and future integrations remain API clients.

The runtime's product object is not a prompt or a model Session. It is authorized, long-lived work that can receive bounded context, survive interruption, have several execution assignments, and produce evidence of what was delivered. A Session, provider call, prompt, task attempt, and model-selected tool call are implementation details beneath that identity.

## Accepted direction

### 1. Domain direction

Future versions will separate at least these concerns, with exact names and schemas decided in bounded ADRs:

- `Source`: a configurable, deterministic event producer with a stable source event id and read position.
- `Trigger`: one immutable, idempotent external or manual event.
- `Thread`: a stable grouping of related Triggers and their context.
- `Mandate`: an immutable authorization record explaining why work may happen and how far it may go. A later event can add context but never silently widen a Mandate.
- `WorkItem`: the long-lived unit of authorized work. It owns its own state and is not equivalent to one model Session, provider call, or execution attempt.
- `Assignment`: one binding of a WorkItem to an executor attempt. It pins the applicable Agent revision, runtime configuration revision, Mandate revision, and provider-neutral model reference.
- `Outbox` and `DeliveryReceipt`: durable records for intended external writes and observed delivery evidence. A worker's `ready` state is not proof of delivery or acceptance.

The existing `Task` remains the implemented phase-1 execution record until an accepted contract migrates it. It must not be silently renamed or reinterpreted as a WorkItem. Future ADRs choose compatibility, migration, and public response shapes.

### 2. Execution and recovery direction

Long-running work must be asynchronous from the client's point of view: creation returns a stable identity, background work emits durable state transitions, and restart reconciliation consults persisted checkpoints. The first implementation of that direction may still use deterministic fake executors and explicit recovery. It must not claim automatic continuation of an in-flight provider call or external side effect before idempotency, Outbox reconciliation, and bounded retry policies are accepted and tested.

An explicit `start/stop` boundary belongs to a future accepted execution contract. Cancellation, terminal failure, interruption, and resumable observation must remain distinct. Current restart-to-`interrupted` plus explicit retry remains the implemented behavior.

### 3. Client direction

Pagurus's direction moves from an Agent configuration console toward a **human-attention workbench**: it should present work requiring authorization, stopping, resumption, or acceptance, plus delivery evidence and explicit recovery states. It remains a client of the versioned Runtime API, never reads private files or the database, and never becomes an execution authority. A separate Pagurus ADR must accept any new client contract after Conchbase publishes it.

### 4. Security and topology direction

All future event intake uses two independent boundaries: deterministic program policy decides what may enter, and an explicit Mandate decides what work may do. Model output, source text, quoted documents, and subscribed context are untrusted data. No Skill, plugin, Agent instruction, or subscription grants capability. Secret use follows [ADR 0023](0023-secret-handle-and-runtime-injection-proposal.md).

Loopback-only binding, no authentication/pairing, one SQLite owner, provider-neutral Agent references, Magpie as one adapter, and the no-real-tool-execution boundary remain current facts. The product does not require cloud persistence, BYOM daemons, remote access, multi-channel integrations, or a model-driven Watchdog to prove this direction.

## Options

### A. Keep the current Agent CRUD and one-turn task product

Consequences: low implementation risk and a stable contract, but the product remains a small configuration surface and does not become a durable personal Agent Runtime. Rejected as the final direction; the current implementation stays intact as its foundation.

### B. Recreate the article's full Super-agent now

Consequences: high conceptual ceiling, but simultaneously introduces unauthenticated remote access, external writes, secrets, tool isolation, crash-safe side effects, multi-channel normalization, Runaway-cost controls, and semantic Watchdog authority. Rejected because the article itself marks security, privacy, long-term memory, context boundaries, and human collaboration as open problems.

### C. Move the product center to persistent authorized work, then add capabilities in bounded slices (recommended)

Consequences: preserves the existing execution-authority and versioning discipline while correcting the product center. It requires new domain and API ADRs before code, but each slice can be validated deterministically. Accepted.

### D. Hardcode Router/Worker or a three-layer role topology

Consequences: easier demonstration and simpler scheduling, but contradicts the user's topology-neutral, highly customizable Agent direction. Rejected; Router/Worker is one possible implementation, not a canonical schema.

## Staged decisions, not implemented here

1. **ADR 0024 or later:** accept the exact domain vocabulary, event envelope, storage schema, and versioned API for Source, Trigger, Thread, Mandate, WorkItem, Assignment, Outbox, and DeliveryReceipt. Use deterministic fake Sources first.
2. **ADR 0025 or later:** accept durable asynchronous execution, `start/stop`, background completion events, restart recovery, and external-action reconciliation. Keep real host tools and external writes out until their isolation and receipt contracts exist.
3. **ADR 0026 or later:** accept one local controllable Source and two-level filtering. Authorization, tool, and secret boundaries precede GitHub, IM, email, or calendar adapters.
4. **Pagurus ADR 0008 or later:** accept a human-attention workbench after Conchbase publishes the read/write contracts it consumes.

Watchdog, speculative execution, cloud persistence, BYOM daemons, remote pairing, and executable approvals remain later layers. Automated real-provider conformance, accessibility validation, and server-side history querying remain separate quality layers, not substitutes for this product direction.

## Validation for accepting the next slice

- ADR records distinguish accepted direction from implemented behavior; OpenAPI changes only when an accepted public contract exists.
- Deterministic fixtures cover duplicate Triggers, context-only subscription, Mandate scope, WorkItem state independent of Assignment state, interruption/recovery, Outbox reconciliation, and delivery evidence without real credentials, user data, network calls, or external writes.
- At least two topology-neutral Agent definitions remain customizable without asserting canonical roles, layers, or Router/Worker names.
- Both repositories run `npm run check`, `npm test`, and `npm run build`; repository guardrails evolve in the same slice as an accepted contract.
- The next slice is accepted only if the local loop feels like durable work rather than Agent CRUD plus a single model answer.

## Consequences

`docs/REFERENCE_PROJECTS.md`, `docs/AI_HANDOFF.md`, `docs/AI_TASK_QUEUE.md`, `docs/ROADMAP.md`, and `README` files record this as direction, not implementation. Pagurus records a matching proposal. No current endpoint, response shape, dependency, database row, or execution capability changes. Existing ADRs `0001`–`0021` preserve their accepted status and scope.
