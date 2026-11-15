# Decision 0068: Restricted and unrestricted execution modes

Status: **accepted and implemented execution-mode policy**

Date: 2026-11-15 (Asia/Shanghai).

## Context

Two separate limits were previously conflated:

1. **Which capabilities an Agent may use.** ADR 0066 makes `grantedCapabilities` part of the immutable Agent revision. This is a scope decision.
2. **Whether a granted capability may run without a human decision.** ADR 0057 gates tools whose declaration says `sideEffect: 'write'`. Nothing gated `external`.

The result was both too restrictive and too permissive at once:

- `src/runtime/mcp-provider.ts` dropped every MCP tool whose declaration was not `read`, so a model could not even see write-capable MCP tools. That is a real freedom limit and the user asked to remove it.
- `TaskService.drainToolCalls` executed `sideEffect: 'external'` immediately with no approval, because only `'write'` matched. Removing the MCP read-only filter without fixing this would have produced unapproved external side effects.

The user asked for both a limited mode and a fully open mode. These are different products for different situations, and pretending one is always right would be wrong in both directions.

## Decision

### 1. One runtime-wide mode, two values

`CONCHBASE_EXECUTION_MODE` accepts `restricted` or `unrestricted`. The default is `restricted`. The mode is runtime-wide, not per-Agent, and is fixed at process start; it is not a task field, a client field, or a model-controlled value. Changing it requires restarting the runtime, which leaves a durable record in the operator's environment rather than in a model's reach.

### 2. Restricted mode

| Side effect | Behaviour |
|---|---|
| `read` | Executes immediately. |
| `write` | Pauses the task in `waiting_approval`. One approval per call. |
| `external` | Pauses the task in `waiting_approval`. One approval per call. |

This closes the pre-existing gap where `external` ran unapproved. It is a behaviour change for any tool that declared `external`, and that gap was a defect rather than a feature.

### 3. Unrestricted mode

Every side-effect class executes immediately. No approval state, no checkpoint, no pause. The Agent loop still records `agent_loop.tool_requested` and `agent_loop.tool_executed` with argument and result digests, so audibility survives even though the gate does not.

Unrestricted mode does **not** bypass:

- `grantedCapabilities` from the pinned Agent revision (scope is separate from approval);
- the bounded MCP configuration schema;
- the sanitized child environment;
- result byte caps, timeouts, iteration limits, or the context budget;
- the rule that a Skill never grants capability.

It removes exactly one thing: the human confirmation step.

### 4. MCP tools are no longer filtered by side effect

`createMcpToolProvider` registers every declared tool regardless of `sideEffect`. Registry membership is not permission: restricted mode still gates `write` and `external`, and unrestricted mode trusts the operator's configuration.

Discovered tools that carry no explicit declaration default to `read`, because the MCP protocol does not report a trustworthy side-effect class. A server that wants its tools treated as `write` or `external` declares them in the bounded config. A new optional per-server `discoverySideEffect` sets the default for undeclared discovered tools, so an operator can mark a whole server without listing every tool.

### 5. The mode is published, not inferred

`GET /v1/runtime` gains an additive `executionMode: "restricted" | "unrestricted"` field. Clients must not infer the mode from the presence or absence of approvals, because an Agent with no write tools never sees one either way. An additive `execution-modes` capability string advertises that the field is meaningful.

### 6. Unrestricted mode is an explicit operator choice, never a default

The runtime never starts unrestricted without the environment variable. There is no client route, task field, Agent field, or prompt that can switch modes at runtime. A model cannot widen its own authority.

## Options

### A. Remove approval entirely

Consequences: a compromised or confused model could mutate external systems, spend money, or rewrite repositories without a single human decision. Rejected as a default, available only as an explicitly chosen mode.

### B. Keep the MCP read-only filter and never add a mode

Consequences: write-capable MCP tools stay invisible, and `external` remains unapproved-but-executable. Both halves were wrong. Rejected.

### C. Two explicit modes, with the external gap fixed in restricted mode

Consequences: operators choose the trade-off consciously; the default stays safe; the open mode is genuinely open. Accepted.

## Validation

- `tests/execution-mode.test.ts` asserts that in restricted mode a `write` tool pauses and an `external` tool pauses, and that in unrestricted mode both execute without entering `waiting_approval` while still emitting requested/executed events.
- `tests/mcp-provider.test.ts` asserts that declared `write` and `external` MCP tools are registered and invocable, and that undeclared discovered tools default to `read` unless `discoverySideEffect` is set.
- `tests/runtime-config.test.ts` asserts the default is `restricted` and that an unknown value is rejected.
- `npm run check`, `npm test`, and `npm run build` pass.

## Consequences

Operators gain a deliberate choice between "the model can act, and I confirm consequential actions" and "the model acts freely". The default remains the former. The MCP read-only filter disappears, so models can see the tools that exist; the approval gate, not visibility, becomes the control in restricted mode.

Unrestricted mode is documented as a trust assumption: everything the Agent is granted may execute without review. It is intended for sandboxed machines, disposable workspaces, and operators who accept that risk.
