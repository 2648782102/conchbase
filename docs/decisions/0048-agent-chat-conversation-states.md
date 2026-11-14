# Decision 0048: Agent Chat conversation states

Status: **accepted and implemented Agent Chat conversation state model**

Date: 2026-11-14 (Asia/Shanghai).

## Context

ADR 0046 adds Agent Chat, ADR 0047 exposes the Runtime-owned Boss Agent inside Agent Chat, and Pagurus ADR 0025 reshapes the workspace into a Codex-style setup-to-chat flow. The first implementation still treats an assistant turn as a thin wrapper over one task: user message is published, assistant message is `pending`, then becomes `succeeded` or `failed`. It does not expose thinking, streaming, organizing, waiting-for-human, cancelled, or provider-unavailable states. A transient model-catalog failure is also reported as HTTP `409`, which reads like a user conflict rather than an upstream availability issue.

Users expect a normal agent conversation: after sending a sentence they should see that the Agent accepted it, is thinking, is streaming/replying, has replied, is waiting for human input, or failed for a specific bounded reason. This must remain a Runtime-owned published projection; Pagurus must not invent local assistant text or authority.

## Decision

1. Conchbase keeps the frozen `1.5.0` Agent Chat path set. `AgentChatMessageState` becomes an additive state vocabulary:
   - `published`: user message accepted;
   - `thinking`: assistant turn accepted, Runtime is preparing model or organization work;
   - `streaming`: partial model output is available;
   - `organizing`: Boss Agent is committing organization actions or waiting for worker reports;
   - `waiting_attention`: Boss Agent produced a structured AttentionRequest;
   - `replied`: final assistant text is published;
   - `failed`: bounded failure with error text;
   - `cancelled`: assistant turn was cancelled;
   - `unavailable`: upstream model/provider/catalog is unavailable.
2. `AgentChatMessage` gains bounded additive fields: `phase`, `progress`, `updatedAt`, and `replyToId`. Legacy `pending` / `succeeded` / `failed` / `cancelled` states remain accepted in fixtures for compatibility but new Runtime messages use the richer vocabulary.
3. For normal configured Agents, Runtime creates and starts an Agent-backed task as before. `refreshConversation` maps task state to conversation state:
   - `queued` / `running` without output → `thinking`;
   - `running` with `partialOutput` → `streaming` with bounded progress;
   - `succeeded` → `replied`;
   - `failed` / `interrupted` → `failed` or `unavailable`, with bounded error;
   - `cancelled` → `cancelled`.
4. For Boss Agent, `postBossMessage` publishes a user message and an immediate `thinking` assistant message, then calls `BossModeService.submit`. While the submit is in flight, polling sees `organizing`. After submit, Runtime publishes `replied`, `waiting_attention`, `failed`, or `unavailable` with the bounded reply/relay and error.
5. Model catalog and provider availability failures are classified as `502` for the HTTP error and `unavailable` for the published assistant message. They are no longer surfaced as a misleading `409`.
6. Pagurus ADR 0026 renders the full state vocabulary in the continuous conversation: waiting dots, streaming caret, progress percentage, organization/waiting-attention labels, failed/unavailable/cancelled messages, and retry action. It keeps Runtime-published text authoritative and never stores a local transcript.
7. Provider-native reasoning text remains blocked. `thinking` means Runtime is preparing or waiting; it does not expose chain-of-thought. Streaming text remains bounded final/partial assistant output from the existing task store.
8. Streaming assistant deltas over SSE, multi-conversation sidebars, attachments, cross-device persistence, and model-native transcripts remain blocked and require separate accepted ADRs.

## Options

### A. Keep `pending → succeeded` and only change UI labels

Consequences: no real thinking/streaming/error distinction; upstream failures remain opaque. Rejected.

### B. Let Pagurus optimistically render assistant replies

Consequences: creates a second source of truth and diverges after restart. Rejected.

### C. Extend the Runtime-published message state model and map task/Boss facts into it

Consequences: genuine conversation states without changing Runtime authority or path count. Accepted.

## Validation

- `tests/agent-chat.test.ts` covers thinking/streaming/replied for a normal Agent, boss organizing/replied/waiting_attention, unavailable classification, cancelled/failed states, idempotent replay, and no private-state leakage.
- `tests/agent-chat-api.test.ts` and `tests/agent-chat-panel.test.tsx` cover expanded state parsing and UI labels.
- Both repositories pass `npm run check`, `npm test`, and `npm run build`.

## Consequences

Agent Chat now has a real conversation state machine and explicit failure semantics while remaining a Runtime-owned client surface. Magpie remains a user-configured OpenAI-compatible protocol endpoint; no provider transcript or chain-of-thought is exposed.

> Implementation boundary: this ADR changes additive `1.5.0` message fields and state vocabulary only; the four Agent Chat paths remain frozen.
