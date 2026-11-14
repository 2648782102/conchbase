# Decision 0049: Boss Agent natural conversation

Status: **accepted and implemented Boss Agent natural conversation boundary; no public API contract changes**

Date: 2026-11-14 (Asia/Shanghai).

## Context

ADR 0047 makes Boss Mode a Runtime-owned virtual 老板 Agent inside Agent Chat. Its first implementation routes every message through the offline deterministic organization-intent parser. Pure conversation falls through to a fixed relay, so the Boss cannot answer questions, explain plans, or decide that no organization action is useful. The optional structured parser only emits action JSON and a parser relay; it is not conversational.

The product requires a normal conversation with the Boss. The user should not have to know whether an answer will create a project, hire an employee, or only be advice. Conchbase provides organization capabilities; the Boss decides when to use them. Runtime must remain the only authority for identity, policy, model references, and state transitions.

## Decision

1. A Runtime-owned conversational brain uses the same user-configured OpenAI Chat Completions-compatible endpoint as Agent Chat. `CONCHBASE_MODEL` is the default model; `CONCHBASE_BOSS_MODEL` optionally overrides it. `CONCHBASE_ORGANIZATION_INTENT_MODEL` retains priority for legacy strict action-only parsing. Startup wires a 30-second upstream timeout so a slow provider becomes an explicit `unavailable` state instead of an indefinite `organizing` state.
2. `AgentChatService` supplies at most eight bounded recent messages to `BossModeService`. `BossModeService` passes that context and a bounded organization snapshot to the parser. The brain returns strict JSON with exactly `reply` and `actions`; the natural `reply` is published as the assistant message.
3. The Boss decides whether to propose capabilities. Ordinary conversation returns `actions: []`; an organization-worthy turn may return accepted action candidates. Runtime replaces `expectedSequence` and `create_agent.model`, reparses all candidates through `parseOrganizationAction`, then commits them through the existing `BossModeService` execution bridge.
4. Plain text, unknown fields, empty/oversized replies, secret-like content, out-of-schema actions, and upstream failures are rejected. Agent Chat publishes `unavailable` with a bounded error, never a fixed conversational phrase.
5. The four frozen `1.5.0` Agent Chat paths and message fields do not change. No new path, schema version, durable transcript, provider-native reasoning stream, or client-local transcript is added.
6. Pagurus ADR 0027 records that the existing conversation UI renders Runtime-published natural Boss replies and organization states without new client authority.

## Options

### A. Configure the strict action parser with a model

Consequences: improved action parsing, still no natural conversation. Rejected.

### B. Let the model call organization APIs or tools

Consequences: model output becomes authority and bypasses policy, approval, and identity checks. Rejected.

### C. Conversational brain plus Runtime adjudication

Consequences: natural replies and optional action proposals with safe bounded validation. Accepted.

## Validation

- `tests/organization-intent-parser.test.ts` covers strict conversational output, pure conversation, action proposals, secret-like replies, unknown fields, and upstream failures.
- `tests/agent-chat.test.ts` covers natural Boss replies, action-triggering conversation, no normal Agent task, no fixed fallback, organization state mutation only when an action is proposed, and unavailable classification.
- `tests/runtime-config.test.ts` covers the Boss model override and default-model fallback.
- Both repositories pass `npm run check`, `npm test`, and `npm run build`.

## Consequences

The 老板 Agent can now hold a normal conversation and use organization capabilities only when useful. Model output remains untrusted data; Runtime keeps sole execution authority. Magpie remains a user-configured protocol endpoint, and no plaintext secret enters prompts, events, logs, errors, or client responses.

> Implementation boundary: this ADR changes internal startup/parser wiring and documentation only; `docs/openapi.yaml`, the four Agent Chat paths, and published schemas remain unchanged.
