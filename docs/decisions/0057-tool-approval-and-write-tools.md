# Decision 0057: Tool approval and bounded write tools

Status: **accepted and implemented write-tool approval slice**

Date: 2026-11-15 (Asia/Shanghai).

## Context

ADR 0052 accepts explicit approval as a Runtime state and ADR 0053 shipped the loop with read-only tools only. `waiting_approval` and `task.approval_requested` already existed in the state machine but no code path could enter them. Without an approval route, a `write` tool would either be impossible or would execute on model output alone, which violates the authority boundary.

## Decision

1. A tool declared `sideEffect: 'write'` never executes from a model turn directly. The loop records `agent_loop.tool_requested`, persists a checkpoint (iteration, tool id, arguments, tool-call id, and the conversation messages), transitions the task to `waiting_approval`, emits `agent_loop.approval_requested`, and returns.
2. `POST /v1/tasks/{taskId}/approval` accepts `{ decision: 'approved' | 'rejected' }`. Approval transitions the task back to `running`, emits `agent_loop.approval_decided`, executes the checkpointed tool exactly once, emits `agent_loop.tool_executed`, and continues the loop with the tool result so the model can answer. Rejection fails the task without executing and clears the checkpoint.
3. A second decision returns `409`. An unknown task returns `404`. An unknown decision value returns `400`.
4. `waiting_approval` is excluded from restart interruption: a pending approval survives a process restart and can still be decided. In-flight model calls remain interrupted as before.
   A later write request in the same task requires its own approval; approval covers exactly one tool call, never a class of calls.
5. The first write tool is `workspace_write`, writing bounded UTF-8 text (16 KiB cap) under the workspace root. It rejects absolute paths, `..`, traversal outside the root, symlinked parents outside the root, and directory targets. It requires an existing parent directory.
6. Write tools are opt-in: `CONCHBASE_ALLOW_TOOL_WRITES=1` registers `workspace_write`. Without it the tool is absent, so a model cannot even request it.
7. The approval route is a new path. The published `1.0.0` 47-path set becomes 48 with this additive task-approval route; the OpenAPI document version becomes `1.1.0` for the runtime contract surface. All additive organization/execution/conversation/Agent Chat contract versions are unchanged, and no other frozen path is reinterpreted.
8. Events carry only tool id, version, arguments digest, result digest, byte counts, and state. Arguments and file contents never enter events, logs, or client responses.

## Options

### A. Execute write tools immediately after policy check

Consequences: model output becomes host write authority. Rejected.

### B. Require approval outside the Runtime (client-side confirmation)

Consequences: every client becomes an approval authority and audit fragments. Rejected.

### C. Runtime-owned `waiting_approval` checkpoint plus an approval route

Consequences: real writes with durable, auditable, restart-safe approval. Accepted.

## Validation

- `tests/agent-approval.test.ts` covers pause-before-write, approve-and-continue, reject-without-write, restart survival, and a duplicate-decision `409`.
- Both repositories pass `npm run check`, `npm test`, and `npm run build`.

## Consequences

Agents can now perform approved local writes with a full audit trail. Arbitrary shell, network writes, external side effects, MCP write tools, and plugin hosts remain blocked pending their own ADRs.
