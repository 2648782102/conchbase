# Decision 0059: Agent Chat tool projection and in-conversation approval

Status: **accepted and implemented Agent Chat tool projection and approval slice**

Date: 2026-11-15 (Asia/Shanghai).

## Context

ADR 0053 added the bounded Agent loop, ADR 0057 added write-tool approval, and ADR 0058 allowed bounded multi-tool turns. Agent Chat, however, only projected task state and `partialOutput`. A user could not see which tool the Agent was using, could not tell that a write was waiting for approval, and had to leave the conversation to call `POST /v1/tasks/{taskId}/approval`. This made the conversation look stalled and broke the Codex-style expectation that a pending approval appears inline.

## Decision

1. `AgentChatMessage` gains an additive `activity` array with at most eight bounded entries. Each entry has `id`, `kind` (`turn`, `tool`, `approval`, `output`), `label`, `state`, and a bounded `detail`. Activity is a read-only projection of Runtime events; it carries tool ids and labels, never arguments, file contents, or provider payloads.
2. A new state `waiting_approval` joins the Agent Chat vocabulary and maps to the `human` phase. Assistant messages in this state expose the pending task id so a client can issue a decision.
3. `POST /v1/agent-chat/conversations/{conversationId}/approval` accepts `{ assistantMessageId, decision }`. It resolves the assistant message to its task, delegates to the existing Runtime approval path, and returns the refreshed assistant message. The Runtime remains the only approval authority; the conversation route is a thin authorized client surface.
4. Approval activity is derived from durable `agent_loop.turn_started`, `agent_loop.turn_completed`, `agent_loop.tool_requested`, `agent_loop.tool_executed`, `agent_loop.tool_failed`, `agent_loop.approval_requested`, and `agent_loop.approval_decided` events in global order. Projection is bounded and deterministic.
5. The Agent Chat contract advances to `1.7.0` with five published paths. The frozen 47-path `1.0.0` platform contract and all other additive contracts are unchanged.
6. Streaming remains polling-based over `GET /v1/agent-chat/conversations/{conversationId}`. SSE, provider reasoning text, and tool arguments remain outside the published boundary.

## Options

### A. Keep approval only on the task route

Consequences: the conversation stalls with no inline action; every client must implement its own task-to-conversation mapping. Rejected.

### B. Let the client execute the write after confirmation

Consequences: the client becomes an execution authority and audit fragments. Rejected.

### C. Project durable loop events and add a conversation-scoped approval route

Consequences: the conversation shows real tool activity and approval stays Runtime-owned. Accepted.

## Validation

- `tests/agent-chat-tools.test.ts` covers projected tool/approval activity, waiting state, in-conversation approval, the resulting write, terminal reply, and duplicate-decision `409`.
- `tests/agent-chat.test.ts` and `tests/agent-chat-history.test.ts` cover the `1.7.0` contract and five published paths.
- `tests/agent-paired-runtime.test.ts` keeps the Pagurus typed client aligned with the upgraded contract.
- Both repositories pass `npm run check` and their test suites for this slice.

## Consequences

Agent Chat now shows which tools the Agent uses and where it is waiting, and a write can be approved inline without leaving the conversation. Arbitrary shell, network tools, write-capable MCP tools, plugin hosts, secret injection, SSE, and provider reasoning remain blocked.
