# Decision 0033: Concurrency, reporting, and archive lifecycle direction

Status: **accepted product direction; development boundary; no public API contract changes**

Date: 2026-11-13 (Asia/Shanghai).

## Context

ADR 0030 accepts concurrent organization work and quiet single-entry reporting. ADR 0031 establishes organization state, and ADR 0032 bounds dynamic Agent authority. Concurrency, reporting, and project lifecycle remain the final runtime behaviors needed before a public organization API can be designed.

The `1.0.0` durable work contract already distinguishes WorkItem, Assignment, Outbox, DeliveryReceipt, control actions, and recovery. The organization layer must use those primitives without adding a second scheduler or treating free-text summaries as state.

## Decision

### 1. Bounded concurrency

The Runtime must control how many workers and assignments may run globally and per project. A later contract defines limit representation, fairness, and admission policy.

User messages, stop requests, and AttentionRequest answers must have priority over launching new autonomous work. A full queue must not prevent the user from continuing the primary conversation or stopping existing work.

Concurrent workers must not write directly into the BossSession. All primary-conversation relays pass through one ordered Runtime path.

### 2. Structured reporting

Worker reports must be structured, mutually exclusive states with bounded payloads. At minimum they cover: draft, progress, waiting, ready, blocked, failed, attention, and ended semantics.

Routine progress belongs in ProjectThread and structured state. The BossSession receives only:

- ready results;
- concrete attention questions;
- blocked or failed states;
- meaningful project summaries;
- explicit user status responses.

Waiting-on-human must be a structured fact. The Runtime must not infer it from free text.

### 3. Attention requests

An AttentionRequest represents one concrete decision or answer. It must be addressable, answerable, withdrawable, and expirable. It must reference the Project, WorkItem, and Delegation that caused it.

An answer may resume work only after the Runtime revalidates the Mandate and current policy. An expired or withdrawn request leaves a structured record and does not silently reopen work.

### 4. Idle, report, archive, offboard

Runtime policy, not model prose, determines when a Project becomes idle. Idle detection must consider active assignments, unread attention requests, recent user messages, and worker reports.

On reaching a reporting boundary, the Runtime requests or derives a structured ProjectReport. It then:

1. persists the report;
2. sends a concise summary to the BossSession;
3. moves detailed history to the ProjectThread;
4. archives the Project;
5. offboards active workers by revoking their active authorization;
6. preserves all events, outputs, decisions, and history.

Offboard is not deletion. A running Assignment may be interrupted or cancelled according to a later state contract; recovery state must remain inspectable.

### 5. Resume and revalidation

A later user message may resume an archived Project only after revalidation of scope, capabilities, policy version, and WorkItem state. Resume creates a new active cycle and a new Assignment; it does not replay a model call byte-for-byte.

The Runtime must deduplicate deliveries and recovery notes so a restart or resume cannot create duplicate side effects.

## Options

### A. Let workers post progress directly into the primary conversation

Consequences: easy to implement, but floods the user and interleaves concurrent turns. Rejected.

### B. Infer waiting/blocked state from model text

Consequences: flexible, but makes reporting unreliable and undermines automation. Rejected.

### C. Use durable work primitives with ordered relay and structured reports

Consequences: preserves quiet single-entry behavior, supports recovery, and keeps Runtime authority. Requires explicit limits and lifecycle contracts. Accepted as a direction.

## Validation requirement

Future implementation must prove:

- multiple projects run concurrently;
- user message and attention answer preempt new launches;
- reports are mutually exclusive structured states;
- routine progress does not enter the BossSession;
- attention answer resumes only after revalidation;
- idle → report → archive → offboard preserves history;
- offboard revokes active authority;
- resume creates a new Assignment and does not duplicate side effects;
- primary-conversation relay order is deterministic.

## Consequences

The final runtime behaviors now have an accepted direction with explicit invariants. No limit policy, event name, public route, or implementation behavior is accepted here.

> Product direction and development boundary only: this ADR does not implement concurrency, reporting, or archive behavior.
