# Decision 0025: Local-first v1.0.0 platform contract

Status: **accepted final local-first public contract and implementation boundary**

Date: 2026-11-11 (Asia/Shanghai).

## Context

ADR 0024 implemented a deterministic durable-work ledger with `0.9.0`, 29 historical paths, `work_item.state = open`, `assignment.state = planned`, and `PRAGMA user_version = 2`. ADR 0022 accepted the direction of asynchronous execution, start/stop, recovery, and delivery evidence. ADR 0023 proposed write-only SecretHandles after authentication and fixed-adapter injection exist. The user requested one final target instead of staged milestones: Conchbase and Pagurus must reach a complete local-first `1.0.0` loop suitable for weaker coding models to continue from.

This ADR accepts the final local-first scope. It is not a cloud, multi-process, arbitrary-tool, or production-secret-vault design. It deliberately records the security trade-off that submitted handle values are sealed at rest with a process-scoped AES-256-GCM key. The key exists only in the current runtime process, so a restart invalidates previously sealed values; the runtime returns `denied` for stale handles rather than claiming cross-process recovery. A one-way SHA-256 digest is stored beside the ciphertext, and only one runtime-owned fixed adapter receives the short-lived plaintext through an in-process call. No model, UI, client, event, response, or generic resolver can read the value.

## Decision

Conchbase `1.0.0` owns one exact 47-path OpenAPI contract, `durable-work-contract` version 2, `PRAGMA user_version = 3`, and six new advertised capabilities: `authenticated-pairing`, `asynchronous-work-control`, `local-source-policy`, `capability-directory`, `write-only-secret-handles`, plus the existing durable-work capability. The existing `Task` resource remains unchanged. Work state has one owner: `work_*` SQLite tables behind `SqliteTaskStore`'s single `DatabaseSync`.

### 1. Authorization and binding

- Default binding remains loopback-only. Non-loopback binding requires both `CONCHBASE_ALLOW_AUTHENTICATED_REMOTE_BINDING=1` and an approved bearer token digest.
- Pairing sessions have `pending | approved | revoked` status and a challenge digest. Token records store only a SHA-256 digest, never a token value. Revoking a pairing revokes its tokens.
- A configured environment token digest or an approved paired token digest permits a non-loopback request. Constant-time digest comparison is used. Token values never appear in logs, errors, responses, or durable events.
- Loopback requests do not require a token. Authenticated non-loopback access is an explicit opt-in, not a default exposure.

### 2. Durable asynchronous work

- `WorkItem` states are `open | running | paused | completed | cancelled`; Assignment states are `planned | running | interrupted | succeeded | failed | cancelled`.
- `start`, `stop`, and `complete` use expected-state checks. `start` also resumes a `paused` item. Completion marks a running assignment succeeded and bounded Outbox/DeliveryReceipt evidence delivered/accepted.
- A process startup reconciliation converts persisted running assignments and work items to `interrupted`/`paused` and appends a `work.recovered` event. Explicit `reconcile` chooses `succeeded` or `failed`; it never claims that an in-flight provider call or external write automatically resumed.
- A separate `decision` route records `accepted | rejected` on an observed DeliveryReceipt. `GET /v1/work/events` exposes bounded durable work, Source, capability, pairing, token, and SecretHandle evidence events.
- Outbox and DeliveryReceipt remain digest-only evidence. `1.0.0` performs no external network write.

### 3. Local Source, policy, and capability directory

- One local controllable Source accepts bounded events with a deterministic `allow | deny` policy. An allowed event may start or resume only a WorkItem whose Thread key matches; a denied event is observed but causes no state transition. Source text, paths, URLs, and secret-like fields are not accepted.
- Program policy (`allow/deny`) and immutable Mandate identity are independent filters. A Source event adds context; it never widens a Mandate.
- `/v1/capabilities` stores bounded `mcp | skill | plugin | secret-handle` directory records with `enabled | disabled` status and a descriptor. Records are configuration data; they do not install code, grant tools, load Skills, connect MCP servers, or execute plugins.

### 4. Write-only SecretHandles

- `POST /v1/secret-handles` accepts a sensitive `value` exactly once. The runtime stores a one-way SHA-256 value digest and an AES-256-GCM sealed value (ciphertext, IV, tag) with stable handle id, key, version, purpose, fixed adapter id, destination binding, status, and timestamps. The sealing key is random per process and is not persisted. It does not store raw plaintext, a public cipher, a plaintext prefix, or a generic resolver token.
- Rotation accepts another one-shot value, seals it with the same process key, and increments the version. Status can be active or disabled. No public route returns a value, cipher, IV, tag, plaintext prefix, reversible encoding, or generic resolver.
- `POST /v1/secret-handles/{handleId}/use` is the only runtime-owned fixed-adapter operation. It checks active status, requires exact route/body handle identity, pinned work/assignment/grant identity, and returns a digest-only receipt with `injected | denied` outcome. The adapter does not expose a value to a model, tool, client, event, log, error, or response.
- This is sealed-at-rest for the current process only, not an OS-keychain or production vault design. A process restart makes old sealed values unopenable; `use` returns a digest-only `denied` receipt and the handle can be rotated with a fresh one-shot value. A real external provider adapter or stable cross-process key source must be separately accepted with OS-managed key custody, fixed destination injection, redaction, revocation, and no-leak fixtures. Magpie credentials remain behind the Magpie compatibility process.

### 5. Client contract

- Pagurus accepts ADR 0010 as the paired client contract. It uses only published `1.0.0` Runtime routes.
- Its workbench becomes a control workbench with start/stop/complete, recovery/reconciliation, delivery decisions, Source policy, and bounded event reads. It remains a client and never owns work state.
- Its capability directory and write-only handle editor submit bounded metadata and one-shot `value` fields. Submission immediately clears the input, and no browser storage, plaintext read field, resolver, or decryptable token is used. Use receipts render digest-only metadata only.

## Architecture and ownership

- `src/runtime/work-contract.ts` owns exact request validation and the version-2 durable-work schemas. `src/runtime/work-store.ts` remains the single reader/writer for `work_*` plan and state tables.
- `src/runtime/platform-contract.ts` owns exact platform request validation and version-2 platform schemas. `src/runtime/platform-store.ts` owns platform tables and delegates all work-state reads/writes to the `WorkStore` interface; it never opens a second SQLite database.
- `SqliteTaskStore` composes `SqliteWorkStore` and `SqlitePlatformStore` with one `DatabaseSync`, performs one migration to `user_version = 3`, and exposes both through `TaskStore`.
- `migratePlatformSchema()` reconciles persisted running work to `interrupted`/`paused` under the database startup transaction; `TaskService` reads the resulting recovery records. HTTP routes remain transport adapters. `createApp` installs one auth hook and one platform route module.

## Exact public contract

`docs/openapi.yaml` version `1.0.0` defines 47 paths:

- The existing 29 historical paths from ADR 0024, with durable-work response envelopes raised to `version: 2` and widened state enums.
- Six work-control/evidence paths: receipt decision, assignment reconcile, work item start/stop/complete, and work events.
- Five authorization paths: pairing collection/approve/revoke and token collection/revoke.
- One local Source path with GET and POST.
- One capability directory path with GET and POST.
- Five SecretHandle paths: collection, rotate, status, use, and use receipts. The collection also supports GET.

All new request schemas reject unknown fields through raw JSON parsing. Validation errors return 400; missing resources return 404; state/digest/identity conflicts return 409; an unconfigured platform returns 503; and unauthenticated non-loopback requests return 401.

## Security and topology boundaries

- Conchbase is the execution authority. CLI, Pagurus, IDEs, and third-party clients are clients.
- Agent definitions, configuration revisions, and Runtime work schemas stay provider-neutral and topology-neutral. Magpie remains one replaceable adapter. No Router/Worker, three-layer role, hierarchy, or canonical coordination pattern becomes a schema field.
- Plaintext handle values never enter model context, prompts, task state, durable events, logs, errors, client responses, Agent revisions, configuration documents, browser storage, URLs, or the frontend bundle.
- Skills are instructions and do not grant tools. Capability directory records do not grant permissions. No host tool, MCP server, Skill loader, plugin, public network service, or external write is executed by this ADR.
- Default loopback-only operation is preserved. Single-process SQLite ownership, no cloud dependency, and deterministic local fixtures remain development boundaries.

## Options

### A. Keep ADR 0024 and leave execution/secrets as staged proposals

Consequences: smallest diff, but leaves the final local loop incomplete and contradicts the requested final-target mode. Rejected.

### B. Reversible encrypted-at-rest values with a stable key and resolver token

Consequences: supports arbitrary later use, but creates a decryptable value path, key-management burden, and an exfiltration primitive if a model or client can influence destination. Rejected for `1.0.0`.

### C. Process-scoped sealed handles with one fixed runtime adapter and digest-only receipts (recommended)

Consequences: the AI can use a sensitive value through a fixed adapter without reading it; a restart intentionally invalidates old sealed values rather than introducing an unmanaged stable key. This keeps the boundary deterministic and rejects replay to arbitrary tools. Accepted.

### D. Full external Sources, MCP lifecycle, plugin host, and multi-process workers now

Consequences: higher feature breadth, but simultaneously changes isolation, side effects, credentials, and deployment topology without deterministic acceptance. Rejected.

## Validation

- Migration 0→3 and 2→3 preserves task, event, configuration, Agent, tool-request, and existing work rows. A failed migration rolls back and can be retried.
- Deterministic tests cover exact 47-path OpenAPI, version/capability fixtures, loopback/auth config, raw JSON rejection, pairing and token revocation, local Source allow/deny, capability upsert, work start/stop/complete, restart recovery, Outbox/receipt decisions, event evidence, and SecretHandle create/rotate/disable/use.
- A sentinel is submitted once. All HTTP responses, durable events, work events, use receipts, handles, errors, and serialized state are asserted to omit the sentinel. The database file contains no raw sentinel bytes; it contains only sealed ciphertext plus a one-way digest. A restart fixture denies stale sealed values.
- Pagurus tests cover typed client response validation, control writes, capability records, write-only editor clearing, no browser storage, no plaintext read/display, and digest-only receipt rendering.
- Both repositories run `npm run check`, `npm test`, `npm run build`, and `git diff --check`. CI uses no real credential, personal data, public-network call, or external write.

## Consequences

`AGENTS.md`, both AI handoffs/development guides, API, architecture, technology, roadmap, validation plan, task queue, README files, SECURITY files, OpenAPI, package/CLI/provider versions, repository guardrails, and Pagurus ADR 0010 record `1.0.0` as the implemented final local-first boundary. Historical ADRs keep their own version statements. There is no remaining staged item inside this target; future external adapters, encrypted value replay, real executor isolation, multi-process ownership, SSE, and cloud deployment require separate accepted contracts.
