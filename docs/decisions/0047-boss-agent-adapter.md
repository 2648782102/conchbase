# Decision 0047: Boss Agent as Agent Chat adapter

Status: **accepted and implemented boss agent adapter**

Date: 2026-11-14 (Asia/Shanghai).

## Context

ADR 0046 adds Agent Chat as a separate module where users choose a configured Agent and receive real model replies. Boss Mode is still exposed as an organization state machine and a primary-conversation projection, not as a selectable Agent. From the user's perspective the product should have a Chinese-named 老板 Agent: the primary conversational entry point that can hire worker Agents, create projects, run work, and report back.

Making Boss Mode a normal mutable Agent profile would let user-edited instructions or model fields bypass the Runtime's authoritative action validation. It would also suggest a canonical role topology, which prior ADRs reject. The right boundary is a Runtime-owned Agent adapter: visible and selectable as an Agent in chat, but implemented by `BossModeService` and the organization state machine.

Magpie remains a user-configured OpenAI-compatible protocol endpoint. Structured Boss intent parsing may use it only through the existing `CONCHBASE_ORGANIZATION_INTENT_MODEL` adapter when the user configures that model id; provider credentials, model routing, and app keys remain in Magpie.

## Decision

1. `GET /v1/agent-chat/agents` includes a Runtime-owned virtual Boss Agent when `BossModeService` is configured. Its published identity is bounded and Chinese: name `老板 Agent`, id `boss-agent`, revision `boss-runtime-v1`, provider `runtime`, model `组织编排`, `archived: false`, `isDefault: false`. No new response fields or paths are added; the `1.5.0` path count and schemas remain frozen.
2. Boss Agent is not a row in `/v1/agents`, not a user-editable Agent profile, not a provider/model catalog entry, not a second Agent schema, and not a canonical role enum or topology. It is an adapter over `BossModeService`.
3. `POST /v1/agent-chat/conversations` accepts `agentId: "boss-agent"` and creates a process-scoped Agent Chat conversation pinned to the virtual Boss identity plus the active configuration revision. It does not create organization state at conversation creation time.
4. `POST /v1/agent-chat/conversations/{conversationId}/messages` on a Boss conversation submits the bounded user text and a derived idempotency key to `BossModeService.submit`. The Runtime remains the only authority that parses, validates, commits organization actions, creates dynamic Agent revisions, binds WorkItems, and publishes reports/Attention.
5. The Boss assistant message is initially `pending` with no task id, then becomes `succeeded` or `failed` from the bounded `BossModeSubmitResult.reply` or a Runtime fallback. Raw provider envelopes, tool-call payloads, SecretHandle plaintext, private paths, and model drafts are never published.
6. A Boss Agent conversation is a view over the single primary conversation; it does not create a second BossSession or ProjectThread. Submitted intents and resulting organization facts remain visible through the `1.4.0` primary-conversation projection.
7. If `CONCHBASE_ORGANIZATION_INTENT_MODEL` is set, Boss Mode may use the existing OpenAI-compatible structured parser through the user's Magpie protocol endpoint. Without it the deterministic offline parser remains active. Conchbase does not manage Magpie configuration.
8. Pagurus ADR 0024 prefers Boss Agent in the Agent Chat picker and labels it as organization orchestration. It does not call organization routes from the Agent Chat panel and does not present Boss Agent replies as locally computed authority.
9. A user-editable Boss Agent profile, model-generated Boss chat transcript, streaming assistant deltas, canonical Boss/HR/employee role enums, and topology schemas remain blocked and require separate accepted ADRs.

## Options

### A. Create a mutable Boss Agent row in `/v1/agents`

Consequences: duplicates organization authority in a user-editable profile and risks prompt injection becoming scheduling authority. Rejected.

### B. Keep Boss Mode only as a separate organization workspace

Consequences: user cannot treat the boss as the primary conversational Agent. Rejected.

### C. Expose a Runtime-owned Boss Agent adapter inside Agent Chat

Consequences: gives the boss a first-class conversational identity while preserving Runtime validation, one primary conversation, frozen `1.5.0` schemas, and topology neutrality. Accepted.

## Validation

An executable fixture must prove:

- Boss Agent appears in the `1.5.0` Agent list with Chinese name and Runtime identity;
- creating and messaging a Boss conversation routes through `BossModeService` without creating a normal Agent-backed task;
- organization session receives the derived intent and Runtime-published project/worker facts;
- the assistant message moves from pending to succeeded with bounded reply and no private-state leakage;
- normal configured-Agent chat remains unchanged;
- Pagurus prefers Boss Agent, labels organization mode, and keeps unsupported Runtime fallback;
- both repositories pass `npm run check`, `npm test`, and `npm run build`.

## Consequences

Boss Mode is now encapsulated for users as 老板 Agent inside Agent Chat while remaining a Runtime-owned organization adapter underneath. Magpie remains a user-configured protocol endpoint; no canonical topology or second user-editable Boss profile is introduced.

> Implementation boundary: this ADR accepts a virtual Runtime-owned Boss Agent adapter over existing `1.5.0` Agent Chat paths only.
