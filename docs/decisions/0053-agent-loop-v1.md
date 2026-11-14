# Decision 0053: Agent loop v1 with bounded read-only tools

Status: **accepted and implemented first Agent loop slice**

Date: 2026-11-14 (Asia/Shanghai).

## Context

ADR 0052 accepts a Runtime-owned bounded loop. This ADR fixes the first implementable slice: enough to let an Agent use a tool and continue reasoning, without crossing the write, external, MCP, Skill, or plugin boundaries.

## Decision

1. Agent-backed tasks may run up to a fixed maximum number of loop iterations (default 6) with at most one tool call per iteration, a context byte budget, and a deadline. Exceeding a bound fails the task with a bounded error.
2. The first capability provider registers exactly three built-in, read-only, deterministic tools:
   - `workspace_list` — lists bounded entries under an allowed root, returning names and sizes only;
   - `workspace_read` — reads a bounded text slice of an allowed file;
   - `text_search` — searches a bounded directory for a literal pattern and returns bounded matches.
   All three enforce a configured allowlist root, reject path traversal, cap bytes returned, and never follow symlinks outside the root.
3. All three tools are side-effect class `read` and execute through the existing policy gate. They are recorded as durable tool events with tool id/version, arguments digest, result digest, byte counts, and state. Raw file contents are not written into events.
4. Provider adapters gain a bounded multi-turn conversation shape: system/Agent instructions, prior user/assistant messages, and prior tool call/result pairs. The Magpie adapter translates this to OpenAI-compatible `messages` with `tool_calls` and `role: "tool"`. Unknown or unsupported shapes fail visibly.
5. A model tool call without a matching registered tool, with malformed arguments, with an out-of-root path, or beyond the byte cap fails the iteration with a bounded error the model can observe, and the loop continues only while within budget.
6. Tasks still pin Agent revision, runtime configuration revision, and effective provider/model. The loop preserves those pins and records the active tool provider revision in each tool event.
7. Restart during a loop marks the task `interrupted`. No tool side effect is replayed. Retry starts a new attempt from the original prompt.
8. Write-capable tools, network tools, MCP, Skills, plugins, arbitrary shell, and secret injection remain blocked and require further accepted ADRs.

## Validation

The following fixtures are implemented and passing:

- `tests/agent-loop.test.ts` covers loop termination on final answer, iteration-budget termination, read-tool success, out-of-root rejection, and the read-only provider surface.
- `tests/streaming-provider.test.ts` covers streamed tool-call accumulation and malformed-call rejection.
- Existing task and provider suites cover pinned revisions, restart interruption, cancellation, and the unchanged legacy single-turn path.
- Both repositories pass `npm run check`, `npm test`, and `npm run build`.

## Consequences

Agents can now read bounded local context and continue reasoning, with authority, bounds, audit, and recovery intact. The provider seam is ready for MCP and Skills, which must reuse it rather than introduce a second executor.
