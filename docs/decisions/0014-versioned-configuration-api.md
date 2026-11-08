# Decision 0014: Versioned configuration documents and Runtime API

Status: **accepted product and public API direction; contracts are versioned in `docs/openapi.yaml`**

Date: 2026-11-08 (Asia/Shanghai).

## Context

[ADR 0004](0004-configuration-revision-proposal.md) accepts content-addressed revisions as an internal identity model but leaves the portable profile schema, validation errors, history, rollback, secret references, and public API open. [ADR 0007](0007-skill-plugin-mcp-configuration-proposal.md) keeps Skill, plugin, MCP bundle formats, lifecycle, and grants open. [ADR 0005](0005-user-defined-agent-topology-proposal.md) requires topology-neutral user-authored composition. The phase-1 runtime currently creates one module-level immutable configuration constant, so every task has the same revision and clients can neither read nor change a configuration document.

`docs/AI_TASK_QUEUE.md` requires an accepted ADR before a public contract changes. Pagurus [ADR 0002](https://github.com/2648782102/pagurus/blob/main/docs/decisions/0002-phase-one-task-operations.md) permits only the three published task writes; its guardrails reject configuration writes until this contract exists. The local Runtime API remains loopback-only, with authentication and pairing still open.

This ADR accepts a narrow versioned document contract for configuration data. It does not accept a composition schema, install or enable any Skill/MCP/plugin, resolve a secret, load code, or execute a tool.

## Decision

### 1. Document and revision

Use a `ConfigurationDocument` with `schemaVersion: 1`, a bounded non-empty `name`, and exactly four arrays of `ConfigurationReference` records: `skills`, `policies`, `mcpServers`, and `plugins`. Each reference has a bounded opaque `id`, a bounded free-form `label`, and a `source` chosen from `inline`, `file`, `registry`, and `env`. A `secretRefs` array holds bounded opaque references. `metadata` is a required bounded string-to-string map, which may be empty. The document does not define an agent topology, layer, role, delegation edge, or coordination pattern.

Normalize and validate every document before hashing. Reject unknown fields, missing required sections, duplicate reference ids, inline content, credential-like field names, embedded secret values, absolute URLs as labels, `source: url`, excessive sizes, and malformed identifiers. URL-sourced references are deferred to a future schema version that defines their validation and security boundary. Canonicalization sorts references and metadata keys. A versioned SHA-256 digest yields a `cfg_` revision id. Existing `createConfigurationRevision` remains an internal compatibility primitive; the public revision uses the document canonical form.

### 2. Durable history and active pointer

Persist immutable revision rows and an append-only history in the same private SQLite database that owns tasks. A singleton active pointer starts from one deterministic bootstrap document on an empty database. A new document is appended only when its computed id differs from the current active id; applying an existing history id makes that revision active. Unknown rollback ids return a normalized `404` error. Tasks keep their original pinned `configurationRevisionId`; a later apply affects only subsequently created tasks.

This is a local single-owner development store. It does not claim a migration policy, WAL crash recovery matrix, distributed consensus, or remote replication.

### 3. Public routes and version

Add five routes under one OpenAPI `0.4.0` document; the health API version remains `1`:

- `GET /v1/configuration` — active revision and document.
- `GET /v1/configuration/revisions` — newest-first revision summaries and the active id.
- `GET /v1/configuration/revisions/{revisionId}` — one immutable full document.
- `POST /v1/configuration/validate` — validate a candidate document without persistence.
- `POST /v1/configuration/apply` — apply a complete document or roll back with `{ rollbackTo }`.

Request and response schemas, status codes, and error bodies live in `docs/openapi.yaml`. Validation failures return `400` with a bounded, field-addressable `details` array; unknown revisions and rollbacks return `404`. A no-op apply returns `changed: false` and the unchanged active revision. The service unavailable case returns `503`. There is no PATCH route, partial merge, file import/export, or direct database access from a client.

### 4. Secret and capability boundaries

A `secretRefs` entry is an opaque reference string, never a secret value. Validation rejects values that look like credentials and rejects `source: env` references that name a secret field in this slice. No document field grants a tool, loads a Skill/MCP/plugin, starts a process, reads a private file, or calls an external service. `source: file` is metadata only; `source: url` is not accepted in this schema version. Pagurus may edit document data through the public API but must not store secrets in browser storage, URLs, logs, or bundles.

### 5. Client direction

Pagurus adds a typed configuration API client and a revision panel with explicit loading, disconnected, validation-error, applied, and rollback states. It uses only the published routes. It can change the active revision but cannot run a task with a pinned future revision; Conchbase assigns the active revision at task creation. Repository guardrails in both repositories are updated in the same slice to allow exactly the accepted writes and reject undocumented configuration paths.

### 6. Non-goals

No topology/composition schema, role registry, Skill/MCP/plugin loader or installation, plugin execution, MCP client SDK, real host tool, approval route, secret store, credential resolution, remote binding, authentication, pairing, portable file I/O, import/export, generated client types, SSE, event retention, or multi-process configuration writer. No change to the phase-1 single-turn model loop or to model-requested tool rejection.

## Options

### A. Keep the module-level revision and expose no API

Consequences: no contract change, but a UI cannot configure anything and weaker models may invent a second schema in Pagurus. Rejected because the queue calls for the configuration slice.

### B. Versioned documents with durable revisions and a narrow API (recommended)

Consequences: one authoritative contract for CLI, GUI, and other clients; deterministic validation and rollback; task pinning remains intact. It adds a public versioned document that must evolve through future ADRs and two repository changes in one slice. The schema deliberately carries opaque references rather than settling bundle formats.

### C. Full portable profile with Skills, MCP, plugins, secrets, and composition now

Consequences: locks unresolved security, lifecycle, installation, isolation, secret-resolution, and topology contracts before their ADRs. Rejected.

## Consequences

`GET /v1/tasks` continues to report `activeConfigurationRevisionId`, but that value now comes from the durable active pointer. Existing task rows are not migrated. A restart preserves history and active revision, then continues to mark nonterminal tasks interrupted. OpenAPI and runtime status versions become `0.4.0`; `/v1/runtime` advertises `configuration-revisions`. Pagurus supports a supported-runtime guard for the new document version while continuing to use health API version `1`.

The document is an intentionally small contract. Future ADRs may add optional sections through a new `schemaVersion`; they must not reinterpret `schemaVersion: 1` in place. A new revision is data only: it does not install, enable, grant, or execute anything.

## Validation

- Pure validator tests cover canonicalization, duplicate ids, unknown fields, bounded values, secret-like values, source restrictions, metadata, rollback shape, and no-op applies.
- SQLite tests cover bootstrap, history across process restarts, rollback, unknown revision errors, and task pinning after a newer revision is applied.
- Fastify injection tests cover all five routes, exact schemas, `400/404/503` errors, active revision reporting, and no undocumented write path.
- Pagurus client tests validate payloads and the accepted write routes; component tests cover loading, disconnected, validation, apply, rollback, error, and keyboard states. No public network, real credential, user data, or real tool is used.
- Both repositories run `npm run check`, `npm test`, and `npm run build`; their CI runs all three.
