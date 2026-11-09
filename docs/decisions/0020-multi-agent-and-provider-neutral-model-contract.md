# Decision 0020: Versioned Agent profiles and provider-neutral model references

Status: **accepted product and public API direction; contracts are versioned in `docs/openapi.yaml`**

Date: 2026-11-09 (Asia/Shanghai).

## Context

The paired product direction is a user-managed collection of independently customizable Agents in Pagurus, with Conchbase owning identities, immutable definitions, execution, and task history. The existing configuration revision is one runtime-wide policy/capability document and must keep its existing meaning. Magpie is the current model compatibility adapter, not the product goal or Agent schema.

The first implementation must give clients a stable resource and task-binding contract without replacing legacy task creation, v1/v2 configuration, the deterministic v2 executor, or the current Magpie flow. A task created through an Agent must preserve the exact Agent revision, runtime configuration revision, and effective provider/model even if the Agent is later edited or archived.

## Decision

### Agent identity and revisions

- Agent ids are runtime-local opaque `agt_` identifiers. Each profile revision has an immutable opaque `agr_` identifier; the mutable Agent record points to its current revision and has a separate archived flag.
- A revision contains a bounded display name, bounded instructions, and a default model reference `{ providerId, modelId }`. It contains no credentials, provider endpoint, or provider-specific settings.
- Create makes the first revision. Update requires `expectedRevisionId` and appends a revision; stale writes return `409` with the current revision id. Duplicate creates a new Agent identity and initial revision from the selected definition. Rollback appends a new revision with the historical content; it never moves or deletes history.
- The first Agent becomes default automatically. Clients can explicitly select a non-archived default or clear it. Archiving a default clears the default pointer. Archive is soft and irreversible in this API; it preserves revisions and tasks. Archived Agents reject new tasks but existing tasks remain inspectable and retryable from their pinned revision.

### Provider-neutral model contract

- Public Agent and task contracts use stable `{ providerId, modelId }` references. Provider catalogs return those values, a stable combined `reference`, a display name, and normalized capability strings.
- The current adapter registers as `magpie` and translates its catalog ids and OpenAI-compatible requests behind its boundary. No Magpie ids, catalog response fields, URLs, or app keys are part of Agent revisions. Unsupported providers/models fail explicitly; the runtime never silently falls back.
- The existing `/v1/models` response and legacy string `model` task input remain available for compatibility. New clients use `/v1/model-catalog` and the Agent/task reference fields. Credentials remain adapter-owned and never appear in Agent documents or client responses.
- Runtime model capability strings describe usable behavior, not vendor vocabulary. The first adapter reports `chat` and `streaming-output`.

### Task binding and legacy behavior

- `POST /v1/tasks` accepts either the legacy `{ prompt, model?: string }` request or an Agent request `{ prompt, agentId, modelOverride?: ModelReference }`. It does not mix both shapes.
- Agent selection is explicit for Agent-backed tasks; there is no implicit Agent fallback. Model override, when present, takes precedence over the selected revision's default model. Unknown, archived, or unavailable selections fail before a task is created.
- Under one SQLite write transaction, task creation reads the current Agent revision and active runtime configuration revision, resolves the effective model reference, creates the task, and records its queued event. The task and queued event expose `agentId`, `agentRevisionId`, `providerId`, and `modelId` for Agent tasks. Legacy task responses omit those optional fields and keep their old behavior.
- Agent-backed tasks always run one model turn through their pinned provider/model and instructions, independent of the active runtime configuration's v1/v2 execution mode. The global v2 deterministic composition path continues to apply to legacy tasks without an Agent id; Agent profiles do not implicitly select or execute that graph.
- Retries preserve the original prompt, Agent revision, runtime configuration revision, and effective provider/model. Cancellation, streaming output, and task-state transitions keep their current semantics.
- Agent instructions are passed as untrusted user-customization context before the user prompt. Runtime policy and system constraints remain authoritative. Instructions never grant tools or permissions. No tool execution is added by this decision.

### API and persistence

- Add `/v1/agents`, `/v1/agents/{agentId}`, `/v1/agents/{agentId}/duplicate`, `/v1/agents/{agentId}/archive`, `/v1/agents/{agentId}/revisions`, `/v1/agents/{agentId}/revisions/apply`, `/v1/agents/default`, and `/v1/model-catalog`.
- Advertise `agents` and `provider-neutral-model-catalog` capabilities. The health API version stays `1`; the OpenAPI/runtime/provider User-Agent version becomes `0.8.0`.
- Apply a transactional, idempotent additive SQLite migration: create Agent tables and add nullable Agent/provider columns to existing task rows. Existing tasks, events, tool requests, configuration revisions, and the active configuration pointer remain byte-for-byte intact. New nullable columns keep old rows legacy-shaped.
- Run migration at database open under an exclusive transaction, track it with `PRAGMA user_version`, and roll back the whole additive migration on failure so it can be safely retried.
- Keep loopback-only binding and the existing Runtime API as the only client boundary.

## Consequences

Pagurus can implement an actual Agent collection and select models without treating Magpie as the platform. The current implementation supports only the `magpie` provider id; the public reference is portable so future adapters can be registered without changing Agent revision shape. Existing `/v1/tasks` clients and CLI task/model workflows continue to work. Agent edit and task creation serialize through SQLite's existing single-owner store, eliminating stale-pin races within the runtime.

The archive operation is one-way for the first slice. Profile revisions contain instructions but no tools, permissions, secrets, or provider settings. Before any future tool can execute for an Agent, authorization and audit identity must include its pinned Agent id and revision.

## Validation

- Deterministic tests cover create/update/stale conflict/duplicate/archive/default/history/apply, provider-neutral catalog translation and unavailable providers, two independent Agents, atomic task revision pinning, model override, retry after edit/archive, unknown Agent, and legacy task behavior.
- Migration tests open a database created by the pre-Agent schema and assert every existing task/event/tool request/configuration revision and active pointer remains unchanged while new Agent tables and nullable columns are added.
- API/OpenAPI tests cover exact schemas, status codes, capability advertisement, and all added paths. Tests use temporary databases and fake provider fetches only.
- Run `npm run check`, `npm test`, and `npm run build`.
