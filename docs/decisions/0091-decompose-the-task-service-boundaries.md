# Decision 0091: Decompose the task service boundaries

Status: **accepted and implemented** (first slice)

Date: 2026-11-16 (Asia/Shanghai).

## Context

ADR 0090 began decomposing the largest files by cohesion. `task-service.ts` was the next target at 1312 lines, mixing four concerns: task lifecycle, the Agent loop, tool execution, and capability projection.

It is the most-shared path in the product — every Agent-backed task, Boss worker task, and Agent Chat turn goes through it — so an unclear boundary there propagates everywhere.

## Decision

Extract the pieces whose contracts are pure, leaving the orchestration that genuinely needs the service's mutable state:

1. **`tool-arguments.ts`** — the canonical argument digest. It is the identity behind both read-result reuse and the durable `argumentsDigest` on tool events, so it must be order-independent and it deserves its own statement of that requirement.
2. **`read-result-cache.ts`** — `ReadResultCache`. Process-scoped, keyed by attempt, so a retry never reuses a previous attempt's read. Encapsulating it removed a map plus two private helpers from the service.
3. **`task-capabilities.ts`** — `resolveTaskCapabilities`. This is a security boundary: capabilities are pinned to the task's Agent revision, grants only narrow, and a missing revision yields no grants rather than falling back to the Agent's current capabilities. As a named function with its own tests it can no longer drift invisibly inside the loop.
4. **`tool-gate.ts`** — `requiresApproval`. Whether a call pauses for a human is a policy decision separate from scope; making it a pure function keeps "unrestricted mode still cannot exceed grants" explicit.

## Deliberately not extracted

`runAgentLoop` and `drainToolCalls` were left in place. They read and write the loop's mutable state — approval checkpoints, message accumulation, per-attempt caching, event recording — through a dozen private members. Extracting them now would replace one large class with a large callback interface, which is a worse shape: the coupling would still exist, just harder to see.

They are the next slice, and they need a small, explicit context object rather than an ad-hoc parameter list. Doing that properly is a design task, not a move.

## Constraints respected

- Behaviour-preserving: the suite passes with no assertion changed.
- No new state owner: every extracted module is either pure or owns only its own small cache.
- Each module has its own tests (11 new assertions), enforced by the module audit.

## Consequences

- `task-service.ts`: 1312 → 1275 lines, with four concerns now named and separately tested.
- The capability and approval boundaries are directly assertable, which they were not before.
- 462 tests pass, module audit clean.
- Remaining in this file: the loop/drain pair and the lifecycle transitions. The loop extraction needs a context object design first.
