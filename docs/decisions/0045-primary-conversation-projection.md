# Decision 0045: Primary conversation projection

Status: **accepted and implemented primary conversation projection**

Date: 2026-11-14 (Asia/Shanghai).

## Context

The Boss-mode Runtime already owns one primary conversation, durable organization actions, dynamic Agent revisions, WorkItems, reports, AttentionRequests, and published `1.1.0` state. The paired console currently exposes an intent composer plus state cards. A user can submit one message but cannot read a coherent conversation: there is no visible user turn, Boss acknowledgement, worker activity, structured report, question, or completion state in one ordered stream.

The complete Organization Runtime target requires one primary conversation that receives user intents and only meaningful reports, while routine progress stays in project threads. It also forbids exposing drafts, private transcripts, locally computed authority, plaintext secrets, or private Runtime state. The existing public `1.1.0` route set is frozen at 18 paths; `1.2.0` and `1.3.0` are also additive frozen contract sets.

A conversation feature must therefore be a read model over Runtime-owned facts, not a second chat product or a UI-side transcript. It should answer "what did I say, what did the Boss acknowledge, what are employees doing, and what came back?" without turning every internal event into chat noise.

## Decision

1. Conchbase implements an additive `1.4.0` primary-conversation projection contract. It does not alter the frozen `1.0.0` 47 paths, `1.1.0` 18 organization paths, `1.2.0` 8 controlled-execution paths, or `1.3.0` 8 execution-run paths.
2. `GET /v1/runtime` keeps `organizationContract: "1.1.0"`, `executionContract: "1.2.0"`, and `executionRunContract: "1.3.0"` for existing clients, and additionally advertises optional `conversationContract: "1.4.0"` and `conversationPaths: 2` when the projection service is configured.
3. New public paths are exact and additive:
   - `GET /v1/organization/conversation`
   - `GET /v1/organization/conversation/messages?after=<messageId>&limit=<n>`
4. A pure runtime projection service reads the authoritative organization snapshot and optional bounded task-state records. It emits immutable, ordered, published conversation messages with stable ids and bounded fields:
   - `user_message` for a recorded primary intent;
   - `boss_acknowledgement` for the Runtime-owned receipt of that intent;
   - `worker_activity` for meaningful worker/project state from accepted organization facts;
   - `report` for a structured report;
   - `attention` for an open or decided AttentionRequest;
   - `system_status` for task-level running/terminal state when a worker execution is known.
5. Conversation messages are a projection, not a durable write model. They are derived deterministically from durable organization events and current state. No second conversation database, no user-created message route, no raw model transcript, no draft, no prompt text, no tool output, no plaintext secret, and no private path is published.
6. A user message body is bounded published text derived only from the accepted intent record. The Runtime owns its text through an in-process bounded intent message store keyed by intent id; persistence is intentionally process-scoped. If the store is unavailable after restart, the projection emits a digest-only placeholder and never invents a transcript. This avoids changing the frozen private SQLite schema in this slice.
7. Routine progress is not duplicated into chat. Each durable event maps to at most one meaningful message, and worker execution facts are represented as bounded status/receipt cards. Project detail remains in `1.1.0` project threads and organization events.
8. Pagurus ADR 0022 consumes the `1.4.0` messages through a typed client and replaces the organization composer/card area with a complete primary-conversation panel: author, role, kind, bounded text, state, sequence, cursor refresh, composer, and inline Attention decisions. It keeps existing organization state cards as supporting detail.
9. Pagurus must not compute Runtime authority, show raw model output, display private paths, or present an optimistic local message as published. It may show a local pending composer state while awaiting the Runtime response, then replace it with published messages.
10. Real model-provider transcripts, streaming assistant deltas, multi-session chat, generic file attachments, cross-device sync, and a writeable message API remain blocked and require separate accepted ADRs.

## Options

### A. Build a client-only chat transcript from optimistic UI state

Consequences: diverges from Runtime facts, cannot survive reload/restart, and risks exposing local secrets. Rejected.

### B. Add a durable writeable chat table and POST /messages route

Consequences: creates a second source of truth, new schema, new idempotency/replay/retention semantics, and a larger public contract before the product need is proven. Rejected for this slice.

### C. Publish a deterministic read model from accepted organization facts with only bounded user text

Consequences: closes the visible conversation loop while preserving Runtime authority and the frozen published state boundary. Accepted.

## Validation

An executable fixture must prove:

- exact additive path count and optional `1.4.0` discovery;
- one user intent produces a user message, acknowledgement, worker activity, and structured report/attention messages in strict sequence;
- no plaintext, private path, raw transcript, prompt, model output, draft, or generic secret resolver vocabulary appears in the projection;
- cursor reads are bounded, idempotent, and reject unknown cursors;
- duplicate events do not create duplicate projected message ids;
- Pagurus typed client and conversation panel gate on `conversationContract: "1.4.0"`, render all message kinds and states, support attention decisions, and keep pending UI state distinct from published Runtime facts;
- both repositories pass `npm run check`, `npm test`, and `npm run build`.

## Consequences

Conchbase and Pagurus now expose the Boss-mode primary conversation as a coherent, reloadable, AI-developable chat surface while remaining a deterministic projection of Runtime-owned facts. Durable chat authoring and provider transcript streaming remain separate ADR-gated work.

> Implementation boundary: this ADR accepts only a published primary-conversation read model and bounded process-scoped intent text.
