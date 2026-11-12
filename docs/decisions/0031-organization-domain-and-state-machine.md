# Decision 0031: Organization domain model and state machine direction

Status: **accepted product direction; development boundary; no public API contract changes**

Date: 2026-11-13 (Asia/Shanghai).

## Context

ADR 0030 accepts a single-entry Organization Runtime direction. It defers concrete domain objects, state machines, events, and state ownership. The Chinese [Organization Runtime target](../../ORGANIZATION_RUNTIME_TARGET.zh-CN.md) raises the objective from a direction note to a complete delivery target. A later model cannot implement that target safely if each concept, transition, and authority boundary remains implicit.

Conchbase `1.0.0` already owns Agent revisions, Task, durable work, configuration revisions, capability records, SecretHandles, and events. Those contracts are closed. The organization domain must compose them without becoming a second execution authority, a second Agent schema, or an unversioned public API.

## Decision

### 1. Structural concepts

A later implementation contract must model the organization with these concepts or documented equivalents:

- **BossSession**: one durable primary conversation and user entry point.
- **Project**: a durable work theme derived from the primary conversation.
- **Delegation**: a parent-to-child authorization relation.
- **Mandate**: the bounded scope and operations inherited by a delegation.
- **AgentRevision**: an immutable worker definition accepted by the Runtime.
- **WorkItem / Assignment**: the existing durable work substrate.
- **ProjectThread**: bounded execution history separate from the BossSession.
- **Report**: a structured worker status or result.
- **AttentionRequest**: one concrete question requiring a user or parent decision.
- **OrganizationEvent**: an immutable lifecycle fact.

These are internal domain concepts until a versioned public API ADR publishes them. They must not be represented as a boss/HR/employee role enum.

### 2. State machines

Project states must distinguish at least: `forming`, `active`, `quiet`, `archived`, `stopped`, and `resumed`. `resumed` is a transition that creates a new active cycle without erasing archive history.

Worker lifecycle must distinguish at least: `proposed`, `authorized`, `running`, `idle`, `reporting`, `blocked`, `offboarded`, and `ended`. A worker may be offboarded while its work item remains recoverable.

Report states must be structured and mutually exclusive. Free text cannot determine whether a worker waits for a human, is ready, failed, or ended. The exact report vocabulary is deferred to the report/concurrency ADR, but it must cover draft, progress, waiting, ready, blocked, failed, attention, and ended semantics.

AttentionRequest states must distinguish at least: `open`, `answered`, `withdrawn`, and `expired`. Answering an AttentionRequest may resume a WorkItem only after the Runtime revalidates the Mandate.

### 3. Authority and writing

An Organization Engine must be the only writer of BossSession, Project, Delegation, Mandate binding, ProjectThread binding, Report, AttentionRequest, and OrganizationEvent state. Models propose structured actions; the Engine validates and commits them.

Every transition must be atomic with its durable event. The Engine must reject stale expected versions, capability escalation, budget escalation, recursion escalation, and unknown model-draft fields.

Existing `Task` and WorkItem state machines remain separate. Organization state may reference them, but must not reinterpret their states.

### 4. Events

OrganizationEvent payloads must contain bounded scalars and opaque references only. They must never contain SecretHandle plaintext, raw credentials, unbounded model output, private file paths, or provider-specific session internals.

The event log must support: creation, delegation, authorization, work start/stop/completion, report, attention lifecycle, idle detection, archive, offboard, revalidation, and resume. Exact event names and payload fields require an implementation ADR.

### 5. Persistence

Organization state must live in the existing Conchbase private SQLite owner. No second database owner, separate private file, or client-side state may become authoritative.

Any migration must be additive, transactional, preserve `user_version = 3` data, and be explicitly versioned. Default loopback-only binding and single-owner behavior remain unchanged in this direction ADR.

## Options

### A. Store organization state only as messages in BossSession

Consequences: simple to explain, but makes free text authoritative and cannot enforce state transitions or authorization. Rejected.

### B. Reuse Task as Project, Worker, and Delegation

Consequences: avoids new concepts, but overloads Task semantics and cannot honestly model multiple workers, parent-child authority, archive/resume, or attention. Rejected.

### C. Add a dedicated organization domain inside the existing runtime owner

Consequences: introduces new internal structures and a migration, but preserves one execution authority, references existing Agent/WorkItem contracts, and supports deterministic validation. Accepted as a direction; implementation still requires later ADRs.

## Validation requirement

Future implementation must provide deterministic fixtures for:

- project state transitions;
- worker proposed → authorized → running → reporting → offboarded;
- mutually exclusive report states;
- attention open → answered/withdrawn/expired;
- atomic event persistence;
- stale version rejection;
- no plaintext or unbounded payloads in events;
- additive migration preservation;
- single-owner compatibility.

## Consequences

The organization target now has a stable conceptual vocabulary and state-machine boundary. Later models can design schemas and fixtures without reinventing the domain. No public API, database migration, or runtime behavior is accepted by this ADR.

> Product direction and development boundary only: this ADR does not implement organization state or make any new capability available.
