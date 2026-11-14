# Decision 0042: Controlled execution direction

Status: **accepted product direction; implementation blocked until separate implementation ADRs**

Date: 2026-11-14 (Asia/Shanghai).

## Context

ADR 0041 completes the local-first Boss-mode product loop. Conchbase owns one primary conversation, dynamic Agent revisions, Delegations, durable work, structured reports, Attention, archive/offboard/resume, and published `1.1.0` state. Pagurus ADR 0018 connects the organization console without computing Runtime authority.

The next user-visible gap is controlled execution: Boss-mode workers currently produce bounded model answers but cannot use real tools, MCP servers, Skill/plugin lifecycle state, external Sources, external writes, or isolated executors. Those capabilities cross a much stronger trust boundary than locally persisted organization facts. They require explicit authority, grants, audit identity, process isolation, approval, crash semantics, and paired client surfaces.

## Decision

1. Controlled execution is accepted as the next product direction, not as an implemented capability. No tool, MCP server, Skill/plugin loader, external Source, external write, or executor is enabled by this ADR.
2. Conchbase remains the sole execution authority. A model, Agent revision, Skill, configuration record, client, or tool output never grants capability by itself.
3. Before implementation, separate accepted ADRs must define:
   - Agent-aware authorization pinned to Agent identity/revision, runtime policy revision, capability revision, Delegation, WorkItem, Assignment, and attempt;
   - explicit grants independent from configuration records and instruction text;
   - executor isolation and process boundaries for MCP, Skill, plugin, and host tools;
   - durable request, approval, execution, result, failure, and cancellation events without plaintext secrets;
   - crash-safe side effects and idempotency for external writes;
   - capability lifecycle: install/enable/disable/revoke/version/audit;
   - error classification for untrusted tool output and provider tool-call accumulation;
   - public API additions and a paired Pagurus ADR for grants, approvals, and audit views.
4. SecretHandle plaintext remains outside model context, prompts, task state, events, logs, errors, client responses, Agent revisions, configuration documents, and UI. A runtime-owned authorized adapter may inject a value only into a fixed destination; no generic resolver is accepted.
5. Existing `1.0.0` Task, work, configuration, and SecretHandle schemas are not silently reinterpreted. Any public contract change requires a versioned additive ADR and executable fixtures.
6. The first implementation slice should be a deterministic fake executor with isolated process boundaries and no real external side effect. Real external Sources, Outbox writes, and production tool hosts require further accepted contracts.

## Options

### A. Add tool execution directly from Boss-mode worker output

Consequences: fastest demo, but prompt injection becomes host authority and violates every accepted security boundary. Rejected.

### B. Treat capability directory records as grants

Consequences: conflates data with authorization and lets configuration edits bypass policy. Rejected.

### C. Accept a staged controlled-execution direction with implementation ADR gates

Consequences: slower, but preserves Runtime authority, auditability, and local-first safety. Accepted.

## Validation before implementation

Each future implementation ADR must provide executable fixtures for authorization pinning, denied execution, explicit grants, executor isolation, digest-only secret use, durable audit, cancellation, crash/restart reconciliation, no plaintext leakage, and paired client rendering. Both repositories must pass `npm run check`, `npm test`, and `npm run build`.

## Consequences

`docs/PROJECT_STATUS.json` records controlled execution as the next ADR-gated direction. It must not be described as implemented until named implementation ADRs and their fixtures are accepted.

> Direction only: this ADR accepts where the product goes next; it does not execute tools or change public contracts.
