# Decision 0034: Organization public contract boundary

Status: **accepted public-contract direction; contract version deferred; no current API changes**

Date: 2026-11-13 (Asia/Shanghai).

## Context

ADR 0025 freezes the exact 47-path `1.0.0` Runtime API. ADRs 0030–0033 accept the organization product direction, domain, dynamic Agent authority, and runtime behavior. A complete Organization Runtime cannot be used by CLI, Pagurus, or third-party clients without a versioned public contract.

No such contract exists yet. Silently adding organization routes to `docs/openapi.yaml` would break the frozen `1.0.0` promise and allow clients to invent semantics for actions whose lifecycle is still undecided.

## Decision

### 1. Version boundary

Organization APIs must be introduced in a new versioned public contract, provisionally called `1.1.0`. The exact version and path count must be accepted by a later public-contract ADR before `docs/openapi.yaml` changes.

The existing 47 `1.0.0` paths remain unchanged. Compatible additive capability advertisement is allowed only under the rules accepted by that later ADR.

### 2. Contract principles

The organization public contract must:

- expose published state and bounded commands, not model drafts;
- identify Agent revisions, Projects, Delegations, WorkItems, Reports, and AttentionRequests with opaque ids;
- carry versioned request/response schemas and explicit conflict errors;
- never expose private files, database rows, provider sessions, SecretHandle plaintext, or raw model transcripts;
- let clients discover supported organization capabilities;
- define idempotency for commands that may be retried;
- define event/cursor semantics before advertising live history;
- keep provider details behind adapter boundaries;
- avoid boss/HR/employee role enums and canonical topology.

### 3. Required capability areas

A future public contract decision must define, at minimum:

- primary conversation read and intent submission;
- project list/detail and lifecycle state;
- dynamic Agent proposal audit views;
- Delegation and Mandate views;
- organization WorkItem and Assignment views;
- Report and AttentionRequest read/answer/withdraw;
- archive, offboard, and resume commands;
- organization event query or subscription;
- error, conflict, authorization, and capability-gating shapes.

The contract must distinguish “proposal accepted for validation” from “Agent revision active” and “AttentionRequest answered” from “work resumed”.

### 4. Client responsibility boundary

Clients may render published facts and submit bounded intent. They must not:

- construct Agent revisions locally;
- compute Delegation inheritance;
- decide archive or resume eligibility;
- infer waiting-on-human from text;
- read or write private Runtime state;
- treat mocks or fixtures as live behavior.

### 5. Paired client requirement

Pagurus must accept a corresponding client ADR before any organization UI is presented as connected behavior. Pagurus may prepare non-authoritative documentation and visual fixtures before the Runtime contract is published.

## Options

### A. Extend the frozen 47-path contract silently

Consequences: fast but breaks the source-of-truth contract and lets clients invent semantics. Rejected.

### B. Keep organization work entirely private to the Runtime

Consequences: avoids public contract work, but prevents CLI, Pagurus, and third-party clients from using the target product. Rejected as a final state.

### C. Publish a new versioned organization contract after domain ADRs

Consequences: preserves `1.0.0`, forces explicit lifecycle semantics, and enables all clients through one source of truth. Accepted as a direction.

## Validation requirement

The future public-contract ADR must include executable fixtures for:

- exact new path set and version;
- request/response schema alignment;
- conflict and authorization errors;
- idempotency;
- event cursor semantics;
- no plaintext/private-state leakage;
- paired Pagurus typed-client alignment.

## Consequences

The organization product now has a clear contract gate. The current API remains frozen while the domain work is designed. No path count, schema, route shape, or release version beyond the provisional direction is accepted here.

> Public-contract direction only: this ADR does not change `docs/openapi.yaml` or make any organization endpoint available.
