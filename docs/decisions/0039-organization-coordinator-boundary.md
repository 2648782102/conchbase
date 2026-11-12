# Decision 0039: Organization coordinator boundary

Status: **accepted internal runtime-service boundary; no public API changes**

Date: 2026-11-13 (Asia/Shanghai).

## Context

ADRs 0031–0038 establish the organization domain, private persistence, execution planner, digest-only dynamic-Agent projection, and the accepted but unimplemented `1.1.0` public contract. The remaining internal gap is the Runtime-owned seam that accepts a structured action, commits it to the authoritative organization store, derives an execution plan, and dispatches only already accepted work-control commands.

The coordinator must not become a second execution authority or expose a route by implication.

## Decision

1. `OrganizationCoordinator` is an internal Runtime-service component. It owns no database and opens no HTTP route; it composes an `OrganizationStore`, `planOrganizationExecution`, explicit work-state reads, and injected work-control callbacks.
2. `submitAction(input)` parses and applies one action through the organization store, then recomputes one execution plan. `reconcile()` recomputes and dispatches a plan without accepting a new action. Both return bounded, inspectable results.
3. Dispatch may call only injected functions matching published work-control semantics: `startWork`, `stopWork`, `completeWork`, and `reconcileAssignment`. Each coordinator invocation dispatches at most one command of each work item to preserve deterministic progress and expected-state conflict behavior. No callback executes a model, tool, or provider call.
4. The coordinator does not create Agent revisions. A dynamic `create_agent` action remains a proposal/projection until a later accepted Runtime-service bridge supplies real bounded instructions and model validation through the existing Agent boundary.
5. The primary-conversation relay is returned as ordered structured facts. The coordinator never sends messages, writes chat state, or infers waiting-on-human from text.
6. Failures in a control callback are surfaced as bounded coordinator results and never roll back an already committed organization action. Retry is explicit through `reconcile()`, preserving published conflict and idempotency semantics.
7. The 47-path `1.0.0` API remains unchanged. ADR 0038 routes require their own implementation slice and paired Pagurus gate.

## Options

### A. Dispatch work directly from the pure planner

Consequences: breaks planner purity and couples deterministic replay to external state. Rejected.

### B. Let HTTP routes call organization stores and work controls directly

Consequences: scatters authority across transports and invites a second schema. Rejected.

### C. Add one internal coordinator with injected published controls

Consequences: keeps Runtime ownership explicit, preserves test determinism, and makes a later public-route slice thin. Accepted.

## Validation

An executable fixture must prove:

- a valid action is applied once and produces one deterministic plan;
- stale sequences are rejected before dispatch;
- only injected work-control callbacks are invoked;
- at most one command is dispatched per work item per invocation;
- callback failures do not erase committed organization facts;
- explicit reconcile can retry without duplicating successful commands;
- relays remain ordered, structured, and digest-only;
- no HTTP dependency, Agent store write, model call, tool call, or OpenAPI change exists.

## Consequences

The Runtime now has a clear internal seam for organization execution. Public API implementation and real Agent revision creation remain separate, fixture-gated slices.

> Internal Runtime-service boundary only: this ADR accepts an injected coordinator, not connected HTTP routes or real model work.
