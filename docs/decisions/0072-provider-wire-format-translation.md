# Decision 0072: Translate provider messages into the wire format

Status: **accepted and implemented provider wire-format fix**

Date: 2026-11-15 (Asia/Shanghai).

## Context

A live MCP probe failed after six iterations while repeatedly calling the same tool that had already succeeded. The event log showed one real execution and three reuses, meaning the Runtime was working and the model was not.

The cause was a missing translation. `ProviderMessage` is a Runtime-owned contract with camelCase fields:

```ts
| { role: 'tool'; toolCallId: string; content: string }
| { role: 'assistant'; content: string; toolCalls?: readonly ProviderToolCall[] }
```

`OpenAiChatCompletionsProvider` forwarded those objects to the HTTP body unchanged:

```json
{ "role": "tool", "toolCallId": "call_1", "content": "echo:hello-mcp" }
{ "role": "assistant", "toolCalls": [{ "id": "call_1", "name": "x", "arguments": {} }] }
```

The OpenAI Chat Completions wire format requires snake_case and a `tool_call_id` on every tool result:

```json
{ "role": "tool", "tool_call_id": "call_1", "content": "echo:hello-mcp" }
{ "role": "assistant", "tool_calls": [{ "id": "call_1", "type": "function", "function": { "name": "x", "arguments": "{}" } }] }
```

So the model received a tool result it could not correlate with the call that produced it, and an assistant turn whose tool calls it may not have recognised as its own. It responded by calling the tool again.

This affected **every** tool call, not only MCP: built-in reads, writes, and MCP tools all share this path. The earlier successful tool runs happened because some models infer intent from the message body alone; others loop. That made the defect look intermittent rather than systematic.

The `ProviderMessage` type documented itself as the internal shape, and `ModelAdapter` is described as the seam that adapters implement. The translation was simply never written.

## Decision

1. A single `toOpenAiMessages` function in `magpie-provider.ts` translates the internal shape into the wire shape at the one place a request body is built.
2. Tool results map `toolCallId` to `tool_call_id`. The internal name never reaches the wire.
3. Assistant tool calls map to `tool_calls` with `type: "function"`, `function.name`, and `function.arguments` as a JSON string, as the protocol requires.
4. Plain messages pass through with only `role` and `content`.
5. The internal `ProviderMessage` contract does not change. Other adapters keep implementing the same seam; each is responsible for its own wire format, which is what an adapter is for.
6. A fixture asserts the exact outbound body, so a future refactor cannot silently reintroduce the camelCase leak.

## Options

### A. Rename the internal contract to snake_case

Consequences: every adapter, every test fixture, and the accepted ADR 0052 loop contract would change to fix a formatting bug. Rejected.

### B. Translate inside `TaskService` before handing messages to the provider

Consequences: `TaskService` would then own provider wire formats, which is exactly the leak the adapter seam exists to prevent. Rejected.

### C. Translate in the provider at request-build time

Consequences: one function, one place, one test, and the seam stays honest. Accepted.

## Validation

- `tests/provider-message-wire-format.test.ts` captures the actual outbound body and asserts `tool_call_id`, snake_case `tool_calls`, `type: "function"`, and JSON-string arguments, and asserts the internal field names do not appear.
- Live MCP probe: before the fix, six iterations and a failure; after the fix, two iterations and a correct answer quoting `echo:hello-mcp`.
- Live built-in probe: three iterations, one execution, one reuse, and a correct answer that also noted the truncation offset.
- `npm run check`, `npm test`, and `npm run build` pass.

## Consequences

Models now receive tool results they can correlate with their calls, which is what makes multi-turn tool use work at all. This was a correctness defect rather than a tuning problem; the earlier reuse and paging work was correct and remains unchanged.

The lesson recorded here: the internal contract was tested and the seam was tested, but the boundary *between* them was not, because the tests used fake providers that spoke the internal shape. A fixture that captures the real outbound request closes that specific gap.
