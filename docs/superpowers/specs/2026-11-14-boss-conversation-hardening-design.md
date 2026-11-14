# Boss conversation hardening design

## Intent

Fix every issue exposed by the 2026-11-14 UI conversation: pure chat must not become organization state, the assistant state must describe the actual Runtime stage, the Boss must receive readable organization facts, product identity and capability limits must be explicit, conversations must survive restart, and waiting must show real provider streaming progress.

## Goals

- Separate natural Boss conversation from organization action commits. `actions: []` from an Agent Chat turn publishes only an Agent Chat assistant message.
- Preserve `BossModeService` as the sole organization authority when the model proposes accepted actions.
- Build a bounded Runtime-owned organization fact projection from organization snapshots, intent text, dynamic Agent revisions, delegations, reports, Attention, and an explicit capability manifest.
- Make the Boss conversation brain stream through the user-configured OpenAI-compatible endpoint. Provider deltas drive `streaming` progress; raw JSON is never shown.
- Keep the frozen four-path `1.5.0` API and published message schema. Add private durable Agent Chat state under `PRAGMA user_version = 5` sharing the existing SQLite owner.
- Mark in-flight assistant messages `unavailable` after restart with a bounded error; preserve conversation and terminal messages.
- Make Pagurus copy describe natural conversation, Runtime-validated organization actions, and the explicit unsupported capability boundary.

## Non-goals

- No web search, device query, host file read, MCP/Skill/plugin lifecycle, arbitrary tool execution, external write, or production remote service. Those remain ADR-gated blocked directions.
- No provider-native reasoning display, chain-of-thought, new public path, new public message field, or second transcript/API authority.
- No rewriting of historical organization events. Existing test-time events remain evidence; new pure Agent Chat turns do not add them.

## Approaches

1. Keep all Boss turns inside `BossModeService` and merely hide `record_intent`. Rejected: state pollution and primary-conversation leakage remain.
2. Let Agent Chat call the provider directly and call organization routes when needed. Rejected: removes Runtime adjudication and duplicates authority.
3. Add an internal `source: 'agent-chat'` path: the conversational brain parses first; pure chat returns immediately with only an Agent Chat message; action turns pass the parsed actions into `BossModeService` for revalidation and commit. Accepted.

## Architecture

`AgentChatService` owns the four published conversation paths and a private `AgentChatStore`. For Boss turns it supplies bounded conversation context and calls `BossModeService.submit` with `source: 'agent-chat'` and a progress callback. `BossModeService` builds organization facts, calls the untrusted conversational brain, and short-circuits before any organization write when no actions are proposed. When actions exist, it calls `onProgress(organizing)`, revalidates every action, commits through the organization kernel, and publishes the natural reply.

`createOpenAiCompatibleBossConversationParser` requests `stream: true`, parses SSE answer deltas, reports bounded progress, parses the final strict JSON, and normalizes identity/capability claim leaks. It accepts a non-streaming JSON fallback for compatibility. `buildBossOrganizationFacts` reads only Runtime-owned facts and omits secret-like content, private paths, and raw provider envelopes.

`SqliteAgentChatStore` shares `SqliteTaskStore`'s one `DatabaseSync`. It persists conversations, messages, and idempotency keys in private tables and recovers in-flight assistant turns on startup. `PRAGMA user_version = 5` is a private additive migration; the published `1.0.0` 47-path contract and additive public contracts remain frozen.

## Security constraints

Plaintext secrets, private paths, provider credentials, raw provider envelopes, and reasoning content never enter prompts, durable events, logs, errors, client responses, Agent revisions, configuration documents, or the UI. Model output is untrusted: replies, actions, identities, and capability claims are bounded and normalized before publication. Every organization action is reparsed by `parseOrganizationAction` and committed by Runtime.

## Validation

Executable fixtures cover pure-chat no-write behavior, real streaming progress, organization action progress, readable organization facts, identity/capability normalization, strict action validation, durable cross-process conversation recovery, in-flight recovery, Pagurus copy/state rendering, repository guardrails, and both repositories' `check/test/build`. A live loopback smoke test uses the user's configured Magpie gateway.
