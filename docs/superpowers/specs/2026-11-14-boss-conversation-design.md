# Boss conversation design

## Intent

The 老板 Agent must hold a normal conversation. It receives the user's message, decides whether organization capabilities help, and either replies naturally or proposes a bounded organization action. Conchbase provides the capability; the Boss decides when to use it. Runtime remains the only authority that commits organization state.

## Goals

- Use the same user-configured OpenAI-compatible protocol endpoint as normal Agent Chat for Boss replies.
- Preserve the frozen `1.5.0` four-path Agent Chat contract and its existing conversation states.
- Let the Boss return natural Chinese or user-language text for ordinary questions, explanations, status questions, and follow-ups.
- Let the Boss propose organization actions when they materially help; Runtime reparses and validates every action before commit.
- Pass bounded recent conversation context and a published organization snapshot to the conversational brain.
- Keep model output untrusted, bounded, and strictly validated; provider failures become `unavailable` rather than fixed text.

## Non-goals

- No new public path, schema version, message field, or second transcript store.
- No direct model access to organization APIs, SQLite, files, secrets, tools, or provider credentials.
- No provider-native reasoning display or chain-of-thought.
- No canonical topology, required Boss workflow, or forced use of organization actions.
- No durable cross-process Agent Chat history.

## Approaches

1. Configure the existing structured parser with a model. Rejected: it can only emit action JSON and fixed parser relays; it still cannot chat.
2. Let the model call organization APIs or tool endpoints directly. Rejected: this removes Runtime authority and violates the policy/approval boundary.
3. Runtime-owned conversational brain with strict JSON `{ "reply": string, "actions": [] }`. Runtime validates the reply, reparses actions through the organization kernel, commits accepted actions through `BossModeService`, then publishes the natural reply. Accepted.

## Contract

The brain is an `OrganizationIntentParser` adapter. Runtime replaces `expectedSequence` and `create_agent.model` before action validation. A pure conversation returns `actions: []` and a natural `reply`; an organization-worthy turn returns at most 16 accepted action candidates and a natural `reply` that explains the action or asks the next useful question. Unknown fields, plain-text output, secret-like text, oversized replies, or out-of-schema actions are rejected and classified as unavailable.

## Security constraints

Plaintext secrets, private paths, credentials, and raw provider envelopes never enter prompts, durable events, logs, errors, client responses, or Agent revisions. The prompt contains bounded conversation text and bounded published organization facts only. The model proposes data; Runtime adjudicates policy, identity, model references, and all state transitions. Magpie remains a user-configured protocol endpoint.

## Validation

Executable fixtures cover natural Boss replies, action-triggering natural replies, strict-output rejection, upstream failure, secret-like reply rejection, no fixed fallback phrase, no normal Agent task for Boss turns, and unchanged four-path discovery. Both repositories run `npm run check`, `npm test`, and `npm run build`.
