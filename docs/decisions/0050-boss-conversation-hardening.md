# Decision 0050: Boss conversation hardening

Status: **accepted and implemented Boss conversation hardening boundary; no public API contract changes**

Date: 2026-11-14 (Asia/Shanghai).

## Context

ADR 0049 gives the Runtime-owned 老板 Agent natural replies, but the live UI conversation exposed six coupled defects: every pure chat wrote `organization.intent_recorded`; assistant messages showed `organizing` while merely waiting for a model; the model received only ID arrays instead of readable organization facts; the model's upstream identity and unsupported capability claims reached users; conversations disappeared on restart; and provider waiting had no real streaming progress.

Natural conversation and organization execution are different responsibilities. Both must remain Runtime-owned, but pure chat must not create organization state.

## Decision

1. `AgentChatService` marks Boss submissions with `source: 'agent-chat'`. `BossModeService` parses the untrusted model result first. When `actions` is empty, it publishes only the natural Agent Chat reply and performs no organization write. When actions exist, it emits an `organizing` progress event and commits through the existing organization kernel.
2. `buildBossOrganizationFacts` projects bounded readable facts: project purpose/origin intent, worker display name/state/instructions/scope/capabilities/model, delegations, reports, Attention, and an explicit capability manifest. The manifest marks external web, local files/device query, external write, and real tool execution unavailable.
3. The Boss conversation brain requests `stream: true` from the user-configured OpenAI-compatible endpoint, parses SSE answer deltas into `streaming` progress, and still accepts a non-streaming JSON response as compatibility fallback. Provider reasoning content is never displayed.
4. Replies are normalized so the product identity is always the Runtime-owned 老板 Agent and unsupported web/file/device claims are replaced with an explicit capability boundary.
5. A private `agent_chat_conversations`, `agent_chat_messages`, and `agent_chat_idempotency` schema persists conversations under the existing single SQLite owner. `PRAGMA user_version = 5` is an internal additive migration only. On startup, nonterminal assistant messages become `unavailable` with a bounded restart error; terminal messages and conversations survive.
6. Pagurus ADR 0028 updates only copy and state labels. It does not add organization authority, local reply generation, a second transcript, or provider configuration.
7. The four frozen `1.5.0` Agent Chat paths, published message fields, the 47-path `1.0.0` contract, and all additive public contracts remain unchanged.

## Options

### A. Keep the single Boss submit path and hide `record_intent`

Consequences: organization events and primary-conversation projections still change during pure chat. Rejected.

### B. Let Agent Chat call the model and organization routes directly

Consequences: the client becomes an execution authority and action validation becomes optional. Rejected.

### C. Parse conversation first, then enter the Boss execution bridge only for actions

Consequences: natural conversation stays side-effect free; organization actions stay Runtime-adjudicated. Accepted.

## Validation

- `tests/agent-chat.test.ts` covers pure-chat no organization writes, natural replies, action-triggering replies, restart-safe durable messages, and unavailable states.
- `tests/agent-chat-store.test.ts` covers reopen, idempotency, and in-flight message recovery.
- `tests/boss-organization-context.test.ts` covers readable fact projection and the explicit capability manifest.
- `tests/organization-intent-parser.test.ts` covers SSE streaming progress, strict output validation, identity normalization, and unsupported capability normalization.
- Both repositories pass `npm run check`, `npm test`, and `npm run build`.

## Consequences

The Boss can chat without mutating organization state, explain what existing projects and workers are, disclose capability boundaries honestly, survive restart for completed conversations, and show real provider streaming progress. Runtime remains the only authority for organization actions.

> Implementation boundary: internal chat storage, prompts, progress callbacks, parser behavior, and Pagurus copy only; public OpenAPI paths and schemas are unchanged.
