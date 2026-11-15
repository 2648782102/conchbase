# Decision 0061: Boss conversation plain-text fallback

Status: **accepted and implemented Boss plain-text fallback**

Date: 2026-11-15 (Asia/Shanghai).

## Context

The Boss conversation parser requires the model to return strict JSON `{"reply":string,"actions":[]}`. Observed provider behavior shows this is not reliable: the same model returns valid JSON on some turns and pure Chinese prose on others, even with an unchanged prompt and context. When that happened, the parser threw `Boss model output is not valid JSON`, `AgentChatService` classified it as `unavailable`, and the user saw "模型返回格式不符合 Runtime 契约" instead of a usable reply. The user cannot act on that message, and the model had in fact produced a complete, helpful answer.

The JSON envelope exists to carry **optional** organization actions. A reply with no actions is semantically identical to plain text. Discarding the whole turn therefore loses value without protecting any authority boundary.

## Decision

1. When the Boss model returns content that cannot be parsed as a JSON object, the Runtime treats the trimmed text as `reply` and sets `actions` to `[]`.
2. The same fallback applies when the model returns a JSON object with a string `reply` but no `actions` field.
3. The fallback is still bounded and validated: text is capped at 8,000 characters, control characters are normalized, and secret-like content is rejected with the existing error.
4. Truncated JSON (content starting with `{"reply":`) is **not** treated as plain text; it remains a parse failure because presenting a half-written JSON envelope would leak internal structure.
5. The fallback never infers or fabricates organization actions. Organization authority is unchanged: actions still require a valid, fully parsed, Runtime-validated envelope.
6. Genuine upstream failures (non-2xx, empty completion, incomplete stream, oversize output, secret-like content) keep their existing classifications and are not masked by the fallback.
7. No public path, schema, or contract version changes. This is an internal parsing policy.
8. Before falling back, the Runtime retries **once** when the first response is not a usable envelope (default `maxAttempts = 2`, hard cap 3). The retry is non-streaming and adds an explicit system instruction to emit only the JSON object. Retries apply only to format problems: non-2xx responses, empty completions, incomplete streams, oversize output, and secret-like content are not retried. If every attempt fails, the **first** plain-text response is published so the user still sees the model's answer.
9. Retries reuse the same bounded timeout budget per attempt and honour the caller's abort signal; a retry never fabricates actions.

## Options

### A. Keep rejecting non-JSON output

Consequences: frequent dead turns with an unactionable error, while the model's real answer is discarded. Rejected.

### B. Retry the model automatically until it returns JSON

Consequences: doubles latency and cost for a purely cosmetic envelope, and can still fail repeatedly. Rejected.

### C. Accept plain text as a reply with zero actions

Consequences: users see the actual answer; organization authority is unaffected because no actions are produced. Accepted.

## Validation

- `tests/organization-intent-parser.test.ts` asserts plain text becomes `relay` with empty `actions`, while unknown fields and secret-like replies still fail.
- `tests/agent-chat.test.ts` asserts a malformed conversational output is published as `replied` with the original text rather than `unavailable`.
- Live verification against the local Magpie model: five consecutive Boss turns that previously failed now all return `replied` with the model's prose.

## Consequences

Boss conversations degrade gracefully when the provider ignores the JSON instruction. Structured actions remain strictly validated, so this cannot broaden execution authority.
