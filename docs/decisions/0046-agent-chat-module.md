# Decision 0046: Agent Chat module

Status: **accepted and implemented agent chat module**

Date: 2026-11-14 (Asia/Shanghai).

## Context

ADR 0045 adds a primary-conversation projection for Boss-mode organization facts. That projection deliberately publishes user intents, Boss acknowledgements, worker activity, reports, Attention, and bounded task status. It is not a natural-language model reply stream. The existing organization parser optionally calls an OpenAI-compatible structured adapter to propose organization actions, but its `relay` is not published as a conversational assistant answer. Users still need a normal module where they can select an independently configured Agent and talk to it through the Runtime.

Conchbase already owns Agent profiles, immutable revisions, default Agent selection, provider-neutral model references, Agent-backed tasks, and a replaceable Magpie/OpenAI-compatible provider adapter. A chat module should reuse those boundaries instead of creating a second Agent schema, a second provider client, or a second task executor.

Magpie remains only a protocol compatibility path. Conchbase must talk to the user's local Magpie gateway through OpenAI-compatible `/v1/models` and `/v1/chat/completions`; model availability, provider credentials, app keys, routing, and upstream configuration belong to the user's Magpie setup. Conchbase must not require users to configure provider credentials inside Conchbase.

## Decision

1. Conchbase implements an additive `1.5.0` Agent Chat contract. It does not alter the frozen `1.0.0` 47 paths or the additive `1.1.0`, `1.2.0`, `1.3.0`, and `1.4.0` contracts. The organization primary-conversation projection and its tests remain unchanged.
2. `GET /v1/runtime` keeps existing discovery fields and additionally advertises optional `agentChatContract: "1.5.0"` and `agentChatPaths: 4` when the Agent Chat service is configured.
3. New public paths are exact and additive:
   - `GET /v1/agent-chat/agents`
   - `POST /v1/agent-chat/conversations`
   - `GET /v1/agent-chat/conversations/{conversationId}`
   - `POST /v1/agent-chat/conversations/{conversationId}/messages`
   
   This ADR fixes four paths; runtime discovery reports the exact published path count as four.
4. An Agent Chat conversation is a Runtime-owned read/write model in process-scoped bounded service state. It pins one `agentId`, `agentRevisionId`, `providerId`, `modelId`, and `configurationRevisionId` at creation. It is not a BossSession and does not create or modify organization projects, workers, Delegations, reports, or AttentionRequests.
5. `POST /v1/agent-chat/conversations` accepts a bounded `agentId` or an explicit request for the Runtime default Agent. It reads the selected Agent through `TaskService.getAgent`, refuses archived Agents, and records immutable identity pins.
6. `POST /v1/agent-chat/conversations/{conversationId}/messages` accepts bounded user text plus an idempotency key. Runtime creates one Agent-backed task through the existing `TaskService.createAgentTask` boundary, starts it, and returns `202` immediately. The user message and pending assistant message are published facts; the assistant message becomes `succeeded`, `failed`, or `cancelled` only after the task reaches a terminal state.
7. `GET /v1/agent-chat/conversations/{conversationId}` projects the conversation from its pinned messages and current task states. It exposes bounded user text, bounded model output, task state, pinned Agent/model/configuration ids, and error text. It never exposes private database paths, SecretHandle plaintext, generic secret resolver tokens, raw provider envelopes, or tool-call payloads.
8. Model replies are real model replies through the existing Agent-backed task path. The configured Agent instructions are prepended by `TaskService.executeSingleTurn`, and the OpenAI-compatible provider adapter calls the local Magpie gateway configured by `CONCHBASE_MAGPIE_URL`. Conchbase does not manage Magpie's provider/model/credential configuration; users configure that in Magpie.
9. Agent Chat does not imply multi-turn memory. Each message is one pinned Agent task with bounded previous messages included in the prompt as bounded context. A full memory/window/summary policy remains a separate ADR.
10. Pagurus ADR 0023 adds a separate `Agent 对话` workspace. It lists configured Agents, creates a chat conversation, renders user and assistant messages with pending/terminal states, and polls for replies. It does not call organization routes and does not present Agent Chat as Boss-mode organization orchestration.
11. Real tool execution, MCP/Skill/plugin lifecycle, external writes, cross-process chat durability, streaming assistant deltas, attachments, and provider-native transcripts remain blocked and require separate accepted ADRs.

## Options

### A. Turn the organization primary conversation into a model chat transcript

Consequences: couples Boss orchestration facts to arbitrary model prose, changes ADR 0045's read-model boundary, and makes organization tests depend on provider output. Rejected.

### B. Build a new provider SDK and credential manager inside Agent Chat

Consequences: duplicates the existing replaceable adapter boundary and puts Magpie/provider configuration in the wrong owner. Rejected.

### C. Reuse Agent profiles, revisions, and Agent-backed tasks over the existing OpenAI-compatible protocol

Consequences: closes the normal chat loop with one new bounded module while preserving Runtime authority and letting Magpie own upstream configuration. Accepted.

## Validation

An executable fixture must prove:

- exact additive path count and optional `1.5.0` discovery;
- a configured Agent can start a conversation with pinned Agent/model/configuration identities;
- a posted message creates a real Agent-backed task and publishes user and pending assistant messages;
- a deterministic fake provider reply becomes a published assistant message with bounded text and no private-path leakage;
- duplicate idempotency keys replay without creating a second task;
- unsupported Agent, archived Agent, missing Runtime service, stale conversation, secret-like text, and out-of-bound input return visible bounded errors;
- organization primary-conversation tests and routes are unchanged;
- Pagurus typed client and separate Agent Chat workspace cover discovery gating, Agent choice, conversation creation, message submit, polling, and unsupported Runtime fallback;
- both repositories pass `npm run check`, `npm test`, and `npm run build`.

## Consequences

Conchbase and Pagurus now expose a normal Agent conversation module independent of Boss-mode organization orchestration. Magpie remains a protocol endpoint configured by the user, not a credential/model management surface owned by Conchbase.

> Implementation boundary: this ADR accepts process-scoped Agent Chat state, bounded per-message Agent task execution, and OpenAI-compatible protocol use only.
