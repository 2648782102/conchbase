# Decision 0055: Agent Chat history recovery and reasoning effort

Status: **accepted and implemented additive Agent Chat 1.6.0**

Date: 2026-11-15 (Asia/Shanghai).

## Context

ADR 0050 already persists Agent Chat conversations in the Runtime's private SQLite store, but no published route let a client discover them. Pagurus therefore held the only reference to a conversation in React state, so refreshing the page created a new conversation. Separately, users had no way to trade latency for depth: the provider received no reasoning-effort hint, and the default chat model was simply the first catalog entry.

## Decision

1. The Agent Chat contract advances to additive `1.6.0`. The four existing paths are unchanged in count; `GET /v1/agent-chat/conversations` is added on the existing collection path.
2. That route returns a bounded list (`limit` 1–50, default 20) of Runtime-owned conversation summaries: id, agent id, reasoning effort, creation time, message count, and a bounded last-message preview. It never returns private paths, provider envelopes, or secrets.
3. The same response carries `defaultModelId`, resolved from the Runtime's configured chat model when that model exists in the provider-neutral catalog, otherwise the first catalog entry.
4. Conversation creation accepts an optional `reasoningEffort` of `low | medium | high` (default `medium`). It is validated, pinned on the conversation, persisted, and forwarded to the provider as `reasoning_effort`. Invalid values return `400`.
5. The default chat model becomes `workbuddy/blind-model-h` when `CONCHBASE_MODEL` is unset, so local testing starts on the designated test model instead of an arbitrary first entry.
6. Private schema advances to `PRAGMA user_version = 6` with an additive `reasoning_effort` column defaulting to `medium`.
7. Pagurus restores the most recent conversation at load, renders the effort selector during setup, and shows the pinned effort in the conversation header. It still keeps no local transcript and no second source of truth.

## Options

### A. Persist conversation ids in browser storage

Consequences: refresh works only on the same browser, creates a client-side source of truth, and is forbidden by the repository's browser-storage boundary. Rejected.

### B. Add a separate `/conversations/list` path

Consequences: an extra frozen path for no functional gain. Rejected.

### C. Add a GET on the existing collection path and pin effort per conversation

Consequences: refresh recovery and effort selection with no new path count. Accepted.

## Validation

- `tests/agent-chat-history.test.ts` covers listing, default model resolution, effort pinning and rejection, and restart survival.
- `tests/runtime-config.test.ts` covers the new default model.
- Pagurus `tests/agent-chat-api.test.ts` and `tests/agent-chat-panel.test.tsx` cover the `1.6.0` gate, effort selector, and history restore.
- Both repositories pass `npm run check`, `npm test`, and `npm run build`.

## Consequences

Refreshing Pagurus returns to the most recent Runtime-owned conversation, and users can choose reasoning depth per conversation. The Runtime remains the only transcript authority; browser storage stays unused.
