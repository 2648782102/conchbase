# Decision 0026: AI handoff readiness development boundary

Status: **accepted repository development boundary; no public API contract changes**

Date: 2026-11-11 (Asia/Shanghai).

## Context

Conchbase ADR 0025 and Pagurus ADR 0010 close the final local-first `1.0.0` public contract. The exact 47-path OpenAPI contract, work contract version 2, `PRAGMA user_version = 3`, process-scoped SecretHandles, and paired client surfaces are implemented and validated. A later coding model must infer the next bounded task from repository state rather than chat history, but the repository contains a large historical task queue and several roadmap items that all require new accepted security or public contracts.

Pushing stable cross-process keys, real external Sources, executable tools, remote pairing UX, cloud deployment, or generated clients from the current state would silently settle security, persistence, authorization, and API contracts. A historical 54-request walkthrough is also described as completed validation even though no executable artifact in the repository reproduces it. The repository needs a deterministic, machine-readable distinction among closed implementation, executable verification, validation evidence, and blocked direction.

This ADR is a repository development-boundary change. It does not change `docs/openapi.yaml`, the Runtime API, configuration schemas, work schemas, SecretHandle semantics, or Pagurus write routes. It does not accept any deferred product capability.

## Options

### A. Treat the existing prose queue as sufficient

Consequences: no new artifacts or tests, but a weaker model must synthesize many historical sections and may mistake a deferred item for an accepted task. There is no machine-readable current state or executable check that the handoff packet remains present. Rejected.

### B. Implement the first deferred capability directly

Consequences: produces visible code, but chooses OS key custody, external side effects, tool isolation, or another unaccepted security contract without an ADR. It may also change the exact 47-path contract. Rejected.

### C. Add a repository-internal handoff packet and executable guardrails

Consequences: a small documentation and test slice; no runtime behavior changes. A coding model receives one authoritative current-state file, one Chinese target-mode brief in each repository, a bounded next-slice index, and guardrails that fail if these artifacts drift. It does not claim that deferred capabilities are implemented. Accepted.

## Decision

1. `docs/PROJECT_STATUS.json` is the machine-readable current-state index for Conchbase. `docs/OBJECTIVE_MODE.zh-CN.md` is the Chinese target-mode brief. `docs/AI_TASK_QUEUE.md` points to both before the historical slices.
2. Pagurus records the corresponding paired client boundary in `docs/decisions/0011-ai-handoff-readiness-development-boundary.md`, `docs/PROJECT_STATUS.json`, and `docs/OBJECTIVE_MODE.zh-CN.md`.
3. Each status file uses JSON arrays named `implemented`, `validationEvidence`, and `blockedDirections`. Only `implemented` records describe current behavior. Every `blockedDirections` record sets `requiresAcceptedAdr: true`.
4. `docs/AI_TASK_QUEUE.md` records that the local-first target is closed and that the next directly executable slice is interface validation. A `nextBoundedSlices` record with `requiresAcceptedAdr: true` is a gated proposal, not a directly executable slice. Persistence hardening requires its own accepted persistence test-boundary ADR before implementation. Cross-process secrets, real external Sources, executable tools, additional provider adapters, history contracts, and composition evolution remain separate ADR-gated directions.
5. Each status file's `aiEntry.requiredOrder` is the canonical AI reading order. Both repositories' repository guardrails parse their status JSON, assert the version, path count, frozen public-contract flag, implemented-versus-planned separation, ADR gates, and consistent `nextBoundedSlices` gating, and check that each handoff's numbered reading order is sequential.
6. The Chinese quick-start remains a reading entry point. The `v1.0.0` release notes and attached Release assets remain an immutable publication snapshot and do not link post-release artifacts. English repository documents, `docs/openapi.yaml`, and accepted ADRs remain the source of truth.

## Executable boundary

- Conchbase and Pagurus each run `npm run check`, `npm test`, and `npm run build` after this change.
- Guardrail fixtures reject a status file that labels a blocked direction as implemented or removes its accepted-ADR gate.
- No new dependency, public route, database owner, provider adapter, external source, tool executor, generic secret resolver, credential, user data, or machine-specific path is introduced.
- `tests/repository-guardrails.test.ts` is updated in the same slice as this accepted development-boundary ADR.

## Consequences

A later coding model can read `AGENTS.md`, `docs/AI_HANDOFF.md`, the status JSON, and the Chinese objective brief to identify a bounded task without relying on conversation history. The cost is a small amount of duplicated, explicitly typed metadata in two repositories. The accepted `1.0.0` contract remains frozen; all product expansion still requires a separate accepted ADR and, where relevant, paired changes in both repositories.

> Development boundary only: this ADR does not reopen the final local-first `1.0.0` target or make any deferred capability implemented behavior.
