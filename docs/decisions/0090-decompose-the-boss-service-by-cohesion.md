# Decision 0090: Decompose the Boss service by cohesion

Status: **accepted and implemented** (first slice)

Date: 2026-11-16 (Asia/Shanghai).

## Context

Before this change `boss-mode-service.ts` was 1518 lines with 44 private methods, doing intent admission, action adjudication, dynamic Agent creation, WorkItem binding, dispatch, waiting, report aggregation, Agent archive/restore, memory writes, and lifecycle batching.

That is a direct violation of this repository's own rule in `AI_DEVELOPMENT.md`: *"Avoid giant files, hidden cross-module behavior."* Four files had crossed 1000 lines (`boss-mode-service` 1518, `task-service` 1312, `organization-contract` 1102, `agent-chat` 1091).

The cost showed up in real defects from recent sessions, all of which were local coupling inside these files rather than missing capability:

- `replied` identity checks broke when success became `done`.
- Two `AgentChatService` instances split an in-memory cache.
- Duplicate implicit `authorize`/`start` steps surfaced as failures.
- `worker_resumed` was written twice.

Each was small, each was missed by a green suite, and each lived in a thousand-line file where the relevant invariant was out of view.

## Decision

Extract by cohesion, smallest independent seam first. Three modules left the service in this slice:

1. **`organization-intent-input.ts`** — intent admission: submission shape, bounds, secret screening, opaque identity derivation, and error bounding. This is the untrusted-input boundary; it changes for reasons unrelated to execution.
2. **`boss-memory.ts`** — `BossMemory`: what recollection to show (bounded, scoped index) and what proposals to persist (after Runtime checks and optional review). Advisory only; never authorises anything.
3. **`worker-outcome-report.ts`** — rendering the Boss reply from real worker outcomes, including the secret-like screen and the length bound.

The service keeps orchestration and now delegates these three concerns. `BossModeServiceError` and `BossModeSubmitInput` remain re-exported so existing importers do not change.

## Constraints respected

- **Behaviour-preserving.** Every extraction is a move, not a rewrite. The full suite must stay green without changing an assertion.
- **No new state owner.** Each module is either a pure function or a collaborator given its dependencies; none gains persistence or a lifecycle.
- **The Runtime stays the only writer and only authority.** `BossMemory` can drop a proposal but cannot create one that the Runtime refused.
- **Each extracted module needs its own tests.** The module audit (`npm run test:audit`) enforces this, and 18 new assertions cover admission rules, memory precedence, and outcome rendering.

## Options

### A. Leave the large files and add discipline

Consequences: the rule already exists and was already being broken; without a structural seam, the next feature lands in the same file. Rejected.

### B. Extract by layer (all "parsing", all "storage")

Consequences: produces modules that share more state than they remove, and forces callers through indirection. Rejected in favour of extraction by cohesion.

### C. Introduce a scheduling "middle platform" service

Consequences: a second state owner and a second scheduler, which the repository forbids. Also unnecessary: `submit` currently awaits each dispatched worker sequentially, so there is no concurrency for a scheduler to order. Rejected.

## Consequences

- `boss-mode-service.ts`: 1518 → 1267 lines, 44 → 40 private methods.
- New modules are directly testable, so the admission and memory-precedence rules are now asserted in isolation rather than only through the service.
- 451 tests pass, module audit is clean, coverage gate holds.
- Remaining decomposition targets, in order: `task-service.ts` (loop versus lifecycle), `organization-contract.ts`, `agent-chat.ts`, and the rest of `boss-mode-service` (action execution versus lifecycle batching).

## Correction to a prior claim

Earlier in the session I argued the system needed dependency edges because a Boss turn would start two workers concurrently and the second would read an empty workspace. Checking the code disproved it: `submit` awaits `collectWorkerOutcomes` for the workers it dispatched, so a turn is sequential. The claim was an assumption presented as an observation. No dependency feature is justified until concurrency actually exists.
