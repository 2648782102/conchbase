# Decision 0024: Durable work domain and versioned public contract

Status: **accepted public contract and first deterministic persistence slice**

Date: 2026-11-11 (Asia/Shanghai).

## Context

[ADR 0022](0022-persistent-work-runtime-direction.md) accepts durable, event-driven, topology-neutral work as the product direction but explicitly leaves the exact vocabulary, schemas, routes, storage, and migration to a later ADR. The `0.8.0` Runtime API remains a phase-1 execution-record contract: a `Task` is one bounded task with attempts, output, cancellation, and retry. Renaming that resource or reinterpreting it as durable work would break the accepted compatibility boundary and the Paired Runtime acceptance suite.

This decision accepts the smallest deterministic public contract for long-lived work. A fake Source can ingest an immutable Trigger and the Runtime can derive a Thread, Mandate, WorkItem, Assignment, Outbox record, DeliveryReceipt, and durable evidence. The records are persisted and readable through the Runtime API. No model is called, no tool executes, no external destination is written, no SecretHandle is stored or resolved, and no background worker changes state after creation.

## Decision

### 1. Version and capability

The OpenAPI document, `/v1/runtime` version, package version, CLI usage version, and provider `User-Agent` become `0.9.0`. `GET /v1/health` continues to report API version `1`. The runtime advertises `durable-work-contract` alongside the existing `0.8.0` capabilities. Pagurus and other clients must gate workbench reads on that capability.

The accepted path set grows from 25 to 29 with exactly these four additive routes:

1. `POST /v1/work/triggers` — ingest one deterministic Source Trigger idempotently and return the derived durable-work envelope.
2. `GET /v1/work/items` — list durable WorkItems and their current state.
3. `GET /v1/work/items/{workItemId}` — read one WorkItem's Mandate, Thread, Assignments, Outbox records, and DeliveryReceipts.
4. `GET /v1/work/delivery-receipts` — list digest-only delivery evidence across WorkItems.

No `PUT`, `PATCH`, `DELETE`, start, stop, resume, approve, execute, write, secret, or generic resolve route is accepted. The four routes use explicit OpenAPI schemas. `POST /v1/work/triggers` parses its raw `application/json` body for its own route scope and delegates exact shape validation to `parseWorkTriggerRequest`, so top-level and nested unknown fields are not silently removed by the HTTP schema compiler. Unknown ids return `404`; malformed JSON, malformed payloads, and unsupported shape changes return `400`; duplicate Trigger ids with different canonical content return `409`.

### 2. Domain vocabulary and invariants

- `Source` is a bounded request field with `sourceId` and `kind: 'manual' | 'fake'`. The first implementation registers no external Source and performs no polling or network read.
- `Trigger` is immutable. The request's `triggerId` is stored as `sourceEventId`; the Runtime derives a separate opaque `trg_` id. `sourceEventId`, `sourceId`, `source.kind`, `threadKey`, `payloadDigest`, `occurredAt`, and the Mandate/Assignment proposal form one canonical identity. Replaying the same canonical Trigger returns the existing envelope and creates no second WorkItem or event. Reusing a `sourceEventId` with different canonical content is a conflict.
- `Thread` groups Triggers by `threadKey` and carries `contextOnly: true`. A new Trigger with an existing `threadKey` may add context to that Thread, but it creates no second WorkItem, Mandate, Assignment, Outbox record, or DeliveryReceipt. It must carry the same Mandate and Assignment proposal; otherwise intake returns `409`. Later context never widens an existing Mandate.
- `Mandate` is immutable per WorkItem. It has `revision: 1`, bounded `scope` strings, `allowedOperations`, and a `capabilitiesDigest`. Later context cannot mutate it. No scope value grants tool execution or secret use.
- `WorkItem` is the stable long-lived identity. Its state is `open` in this first contract and is independent of any Assignment's state. It pins `mandateId`, `mandateRevision`, `threadId`, and `triggerId`.
- `Assignment` is one deterministic execution binding. It pins `agentRevisionId`, `configurationRevisionId`, `mandateRevision`, and a provider-neutral `model: { providerId, modelId }`. Its state is `planned`; the Runtime does not start it. It has no canonical role, layer, label, or topology field.
- `Outbox` records are `pending` intended effects with a `destinationDigest`, `payloadDigest`, and `status`. No adapter sends them. A `ready` or `planned` Assignment is not delivery evidence.
- `DeliveryReceipt` records are `observed` evidence with `outboxId`, `destinationDigest`, `payloadDigest`, and `status`. In this deterministic slice they prove that a fake observation can be persisted and read; they do not prove an external write.
- `WorkEvent` is a durable, ordered, Runtime-owned event in a separate table. Event types are `work.trigger_ingested`, `work.item_created`, `work.assignment_planned`, `work.outbox_recorded`, and `work.delivery_observed`. Each carries bounded scalar evidence, never raw Trigger payloads, credentials, secret values, private paths, or model output.

The Runtime computes opaque ids and digests deterministically from canonical input with `node:crypto`. Opaque ids use bounded prefixes: `trg_`, `thr_`, `man_`, `work_`, `asg_`, `obx_`, `dlv_`, and `evt_`. The vocabulary is topology-neutral; Router, Worker, hierarchy names, layer counts, and coordination roles are not schema fields.

### 3. Public envelope

`POST /v1/work/triggers` accepts:

```json
{
  "source": { "sourceId": "fake.inbox", "kind": "fake" },
  "trigger": {
    "triggerId": "event-001",
    "threadKey": "thread-a",
    "payloadDigest": "sha256:...",
    "occurredAt": "2026-11-11T00:00:00.000Z"
  },
  "mandate": {
    "scope": ["read-local-fixture"],
    "allowedOperations": ["observe"],
    "capabilitiesDigest": "sha256:..."
  },
  "model": { "providerId": "fake", "modelId": "fixture" },
  "agentRevisionId": "rev_fixture",
  "configurationRevisionId": "cfg_fixture"
}
```

All strings are bounded non-empty values. `payloadDigest`, `capabilitiesDigest`, and every destination/payload digest in the response must match `sha256:<64 lowercase hex>`. Raw payload text, credentials, absolute URLs, local file paths, and provider-specific settings are not accepted. `source.kind: 'manual'` is reserved for an explicit client-submitted Trigger and has the same no-external-write boundary.

A successful response is `201` when a new Trigger is ingested and `200` for an exact replay. Its envelope contains `version`, `created`, `workItemCreated`, `contextOnly`, `trigger`, `thread`, `mandate`, `workItem`, `assignments`, `outbox`, `deliveryReceipts`, and `events`. `created` means a new immutable Trigger was stored; `workItemCreated` is true only for the first Trigger of a Thread; `contextOnly` is true when a later Trigger adds context without creating work. A duplicate replay returns the canonical stored envelope without creating new rows or events.

### 4. Persistence and compatibility migration

The existing `TaskStore` remains the single owner of one SQLite database. ADR 0011's exclusive lock and ADR 0020's `user_version = 1` additive migration are preserved. This decision performs one further additive migration to `PRAGMA user_version = 2` inside the same exclusive startup transaction:

- `work_triggers`, `work_threads`, `work_mandates`, `work_items`, `work_assignments`, `work_outbox`, `work_delivery_receipts`, and `work_events` are `STRICT` tables.
- All existing task, event, configuration, tool-request, and Agent rows and pointers remain intact.
- Canonical Trigger identity is unique. Work rows are created in one transaction with their events.
- A failed migration rolls back and can be retried; a second database owner still produces `DatabaseInstanceError`.
- No second `DatabaseSync` handle is opened for the same database.

`TaskStore` gains narrow methods for Trigger intake and durable-work reads. A fake store used by tests implements the same interface. `TaskService` is not given a second durable-work owner. The HTTP routes receive a `WorkContractService` that owns validation and delegates persistence, keeping Fastify free of domain rules.

### 5. Security and execution boundary

The intake route is unauthenticated loopback like the rest of `0.9.0`; it accepts only bounded deterministic data and never acts as a generic executor or secret oracle. Loopback-only binding, authentication/pairing, provider neutrality, Skills as instructions only, policy/approval before tool use, and no real tool execution remain unchanged. [ADR 0023](0023-secret-handle-and-runtime-injection-proposal.md) remains a proposal and is not implemented here.

The first slice does not accept asynchronous start/stop, background completion, restart reconciliation of active Assignments, real Sources, external writes, model calls, MCP/Skill/plugin lifecycle, approvals, SecretHandles, or Pagurus writes. Those require ADR 0025 or later. Restart preserves stored rows and exact replay idempotency; it does not resume an in-flight operation because none exists.

## Options

### A. Reinterpret `Task` as WorkItem

Consequences: fewer tables and a smaller diff, but breaks the phase-1 contract, pinned attempt semantics, CLI reads, Pagurus history, and ADR 0021 acceptance. Rejected.

### B. Add durable tables with private-only state and no public routes

Consequences: avoids an API version change, but leaves clients unable to inspect work and forces Pagurus to read private state or invent a second schema. Rejected.

### C. Four read-oriented routes and one deterministic Trigger intake (recommended)

Consequences: a small public contract and an observable first loop with explicit idempotency, while preserving execution authority and keeping clients API-only. Accepted.

### D. Build Sources, asynchronous workers, Outbox delivery, and secrets now

Consequences: a more complete demo, but simultaneously settles authorization, external side effects, recovery, credential handling, and adapter isolation without accepted contracts. Rejected.

## Validation

- Deterministic tests cover duplicate Trigger replay, conflicting Trigger id reuse, context-only Thread grouping, immutable Mandate scope, WorkItem state independent from Assignment state, Outbox/DeliveryReceipt evidence, restart preservation, raw-JSON unknown fields and malformed JSON returning `400`, no external writes, no model/tool/secret calls, and no canonical topology vocabulary.
- OpenAPI, HTTP, runtime capability, package/CLI/provider version, paired runtime, migration, and repository-guardrail tests move together to `0.9.0`, 29 routes, `user_version = 2`, and `durable-work-contract`.
- Pagurus accepts a paired ADR 0009 and adds a read-only attention workbench using three of the four published routes. It does not call `POST /v1/work/triggers`, add writes, read private DB state, or show secret plaintext fields.
- Both repositories run `npm run check`, `npm test`, `npm run build`, and `git diff --check`; no real credential, user data, public-network call, or external write is used.

## Consequences

This ADR is a current implemented boundary, not a direction record. `docs/openapi.yaml`, `docs/API.md`, entry documents, README files, architecture, technology, validation, task queue, roadmap, SECURITY, and guardrails must say `0.9.0`, 29 routes, and `user_version = 2` once validation passes. Historical ADRs keep their own version statements. The first durable-work task queue item closes; ADR 0025 remains the next slice for durable asynchronous execution.
