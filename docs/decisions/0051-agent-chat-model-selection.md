# Decision 0051: Agent Chat model selection

Status: **accepted and implemented additive Agent Chat model-selection boundary; no new path**

Date: 2026-11-14 (Asia/Shanghai).

## Context

Task operations and Agent configuration already select models from Conchbase's provider-neutral catalog, but Agent Chat conversations always inherited the Agent revision's model. That left the Boss Agent without a way to choose among models exposed by the user-configured Magpie gateway, even though its conversational brain is a real provider call.

## Decision

1. `POST /v1/agent-chat/conversations` accepts an optional provider-neutral `modelOverride: { providerId, modelId }`. Runtime validates it against the existing Magpie catalog before creating the conversation. An unknown provider or model returns `400`.
2. The selected model is pinned on the conversation record. Ordinary Agent turns use it as the Agent task's model override. Boss turns pass it into `BossModeService`, which requests that model from the user-configured OpenAI-compatible endpoint.
3. The default remains unchanged: without an override, an ordinary Agent uses its revision's model and the Boss uses the configured Boss/default model.
4. Pagurus lists `/v1/model-catalog` on the Agent Chat setup screen and sends the selected reference. Credentials, routing, and provider configuration remain user-owned in Magpie.
5. No new path, database table, public message field, or second schema is added. The four frozen `1.5.0` paths remain unchanged; only the create request accepts a new optional property.

## Options

### A. Add a model field to every message

Consequences: duplicate configuration per turn and unclear authority. Rejected.

### B. Let Pagurus pass a model without Runtime validation

Consequences: invalid or unavailable models surface only after a task starts. Rejected.

### C. Validate and pin the model when the conversation is created

Consequences: the chosen model is explicit, validated, and stable for the conversation. Accepted.

## Validation

- `tests/agent-chat.test.ts` covers a selected model override, rejection of an unavailable model, and Boss conversation model pinning.
- `tests/organization-intent-parser.test.ts` covers provider request model selection.
- `tests/agent-chat-panel.test.tsx` covers loading the Magpie catalog, rendering the model selector, and sending the selected override.
- Both repositories pass `npm run check`, `npm test`, and `npm run build`.

## Consequences

Every implemented model-consuming surface now offers a Magpie-catalog model choice. Runtime remains the validation and execution authority; Magpie remains the user-configured provider gateway.
