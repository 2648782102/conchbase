# Decision 0058: Multiple tool calls per turn

Status: **accepted and implemented bounded multi-tool turns**

Date: 2026-11-15 (Asia/Shanghai).

## Context

ADR 0053 and 0057 fixed the loop at exactly one tool call per model turn. Real models frequently emit several independent calls at once (for example, list two directories or write two files). Rejecting the whole turn forced extra model round-trips, consumed the iteration budget, and produced confusing failures such as "Agent loop v1 accepts exactly one tool call per turn".

## Decision

1. A turn may carry up to `maxToolCallsPerTurn` calls, default 4 and hard-capped at 8. A turn above the cap fails with a bounded error; the model can retry with fewer calls.
2. Calls in a turn execute in order. Read tools run immediately. A write tool pauses the task before execution and persists a checkpoint containing the remaining calls, so each write is approved individually.
3. After an approved write, the remaining calls in the same turn continue first; only then does the loop ask the model for the next turn. A second write in the same batch triggers its own approval.
4. A write already completed with identical arguments is not re-approved; the loop returns a tool message telling the model not to repeat it.
5. Every call still emits `agent_loop.tool_requested`, `tool_executed`, or `tool_failed` with tool id, version, arguments digest, result digest, and byte count. Arguments and file contents never enter events.
6. The system prompt now states the per-turn cap instead of requiring exactly one call. Bounds on iterations, time, and context remain unchanged.
7. No public path or schema changes. The approval route and task states are unchanged.

## Options

### A. Keep one call per turn

Consequences: wasted iterations, no support for natural parallel tool requests. Rejected.

### B. Allow unlimited calls per turn

Consequences: unbounded execution and audit volume from a single model message. Rejected.

### C. Bounded batch with per-write approval

Consequences: fewer round-trips while every write stays individually authorized. Accepted.

## Validation

- `tests/agent-multi-tool.test.ts` covers multiple reads in one turn, two writes requiring two approvals, and cap rejection.
- `tests/agent-approval.test.ts` covers single-write approval, rejection, restart survival, duplicate-decision conflict, follow-up read, repeat write, and identical-write idempotency.
- Both repositories pass `npm run check`, `npm test`, and `npm run build`.

## Consequences

Agents can express natural multi-step tool use in one turn without weakening approval or audit. Unbounded parallelism, concurrent tool execution, and write-capable MCP tools remain blocked.
