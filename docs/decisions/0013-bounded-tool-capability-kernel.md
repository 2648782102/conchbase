# Decision 0013: Bounded tool capability kernel

Status: **accepted internal architecture boundary; no public API contract changes**

Date: 2026-11-08 (Asia/Shanghai).

## Context

[ADR 0010](0010-first-real-model-slice.md) keeps the phase-1 HTTP task path single-turn and rejects model-requested tools. [ADR 0012](0012-streaming-output-progress.md) also rejects streaming tool-call deltas. `src/runtime/policy-gate.ts` and `src/runtime/task-runner.ts` are deterministic acceptance primitives: they show that a denied or unapproved tool does not execute, but they do not define an authoritative tool registry, explicit approval records, idempotent side effects, or an audit event vocabulary.

`docs/AI_TASK_QUEUE.md` makes the tool capability slice the next bounded item and requires an accepted ADR before a public contract changes. [ADR 0007](0007-skill-plugin-mcp-configuration-proposal.md) keeps portable profiles, Skill bundles, plugin isolation, MCP lifecycle, and per-tool grants open. [ADR 0003](0003-event-ordering-proposal.md) keeps the durable global event log authoritative.

This ADR accepts the narrow internal kernel needed before any future real tool can execute. It does not connect that kernel to a provider, HTTP route, CLI command, Pagurus form, MCP server, Skill loader, plugin host, or private file. No public API or OpenAPI schema changes.

## Decision

### 1. Tool registry and policy

Add an in-memory, immutable `ToolRegistry` with explicit registration of a tool `name`, a `sideEffect` classification (`read` or `write`), a `requiresApproval` flag, a bounded argument shape, and a deterministic executor. Registration rejects duplicates, empty names, and overlapping `allowedTools`/`approvalRequiredTools` policy sets. Policy is derived from registry entries, not from a Skill, plugin manifest, provider output, or model message.

A tool name is an opaque identifier with a conservative character bound. The first accepted registry contains only fixture executors that mutate in-memory test state; no filesystem, network, process, shell, database write, or host-specific effect is available. Real adapters remain future work.

### 2. Explicit approval records

Add a versioned approval record shape: `{ version: 1, id, taskId, attempt, toolName, argumentsDigest, decision, reason, createdAt }`, where `decision` is `approved` or `rejected`. An approval is valid only for one task, attempt, tool name, and canonical argument digest. A rejected, malformed, or unmatched approval never authorizes execution. Approval records are produced by explicit runtime-facing API objects or deterministic fixtures; they are not inferred from a model turn and are not granted by Skill metadata.

### 3. Idempotent execution records

Add an execution coordinator keyed by `(taskId, attempt, toolName, argumentsDigest)`. The first execution stores its bounded, normalized result or one stable failure digest; a replay of the same key returns that outcome through a deterministic audit error without invoking the executor again. A different key executes separately. The coordinator is per runtime process; it is intentionally not a crash-recovery or distributed transaction boundary. Retry with a new attempt uses a new key, making a repeated side effect visible in its attempt identity. An executor result that is not a bounded string uses the same normalized failure outcome.

### 4. Deterministic audit trail

Add named internal tool audit events: `tool.requested`, `tool.approval_required`, `tool.approved`, `tool.rejected`, `tool.executed`, `tool.replayed`, `tool.denied`, and `tool.failed`. They are ordinary `RuntimeEvent` values in an in-memory deterministic log for this slice. New durable event types, public event shapes, and SQLite columns are not accepted here. Audit data contains only bounded scalars: tool name, decision, idempotency key, and short normalized result/failure digests. It never contains secrets, raw arguments, approval reasons, provider response bodies, or tool outputs with untrusted free-form content. Rejections and executor failures expose their event list through typed errors so a caller can inspect the decision without losing the audit trail.

### 5. Gate order

For every request: resolve the registry entry, validate bounded identity and arguments, compute the canonical argument digest, append `tool.requested`, evaluate policy, require a matching well-formed approval record when needed, then check idempotency before executor invocation. Denial, missing approval, invalid arguments, duplicate registration, and executor errors never invoke the side effect twice. The executor is always called through the coordinator and the policy gate; a Skill or model output supplies no capability. A non-object request produces an empty audit event list rather than throwing an unchecked host error.

### 6. Non-goals

- No `ToolExecutionRequest` endpoint, approval endpoint, tool listing endpoint, SSE tool stream, or OpenAPI change.
- No model tool-call parsing, streaming tool calls, multi-turn tool loop, or changes to `POST /v1/tasks`.
- No MCP SDK/client, process lifecycle, filesystem tool, shell tool, network tool, plugin host, Skill loader, credentials, secret store, or portable profile schema.
- No production authorization UX, remote approval, durable approval store, cross-process idempotency, WAL crash recovery, or automatic retry of an in-flight side effect.
- No changes to Pagurus; it must not present tool approval or installation as implemented.

## Options

### A. Keep only the existing primitive

Rely on `policy-gate.ts` and `task-runner.ts` until a provider emits tool calls.

Consequences: no code change, but the next model could wire a real tool without explicit registry, approval identity, replay, or audit semantics. Rejected because the queue explicitly asks for those boundaries first.

### B. Bounded internal kernel (recommended)

Implement the registry, approval records, idempotency coordinator, and deterministic audit events behind a single internal facade, with no public contract change.

Consequences: a weaker model gets executable guardrails and deterministic tests for the security path. It adds a focused module and test file but does not expand runtime dependencies or settle product schemas. The kernel remains in-process and is not evidence that Conchbase can execute real tools.

### C. Public tool and approval API now

Expose routes for tool registration, approval, and execution before configuration and pairing are accepted.

Consequences: prematurely locks authentication, API versioning, UI state, audit retention, and capability grants. Rejected.

## Consequences

The internal acceptance harness becomes safer and more explicit. `task-runner.ts` can later be migrated to the new facade behind another accepted slice; the phase-1 HTTP path stays unchanged. Guardrails are updated alongside this ADR to check that the public route set and OpenAPI version do not change, that no MCP/provider SDK appears, and that the kernel does not import private-file or HTTP modules.

The accepted decision narrows but does not close the tool capability slice: after this kernel, a future ADR must decide the public configuration/approval API, provider tool-call contract, durable audit storage, and real executor isolation before any model-requested tool is executed by the Runtime API.

The internal `TaskEventType` union gains tool-prefixed values because the deterministic event log requires a typed event name. This is not an accepted public event vocabulary: `src/http/routes/v1/`, `SqliteTaskStore`, and `TaskService` continue to emit only the phase-1 task events documented by OpenAPI `0.3.0`. A future public tool contract must define disclosure, persistence, and schema versioning separately.

## Validation

- Registry tests reject duplicate, empty, and policy-conflicting registrations.
- Approval tests prove matching task/attempt/tool/argument records authorize once and that mismatches, rejections, and stale attempts do not authorize.
- Idempotency tests prove the same key invokes the executor once, a replay returns the stored result, and a new attempt uses a distinct key.
- Audit tests prove ordered event types for success, rejection, invalid requests, and executor failure; that secrets, raw arguments, and free-form tool output never enter event data; and that a failed executor is replayed without a second invocation.
- Repository guardrails prove that no public HTTP route mentions the internal `tool-capability` module, that its code has no HTTP import, and that `TaskService` does not import it.
- Existing phase-1 provider, task-service, HTTP, OpenAPI, and repository guardrail tests remain green; CI uses no credentials, public network calls, real tools, or personal data.
