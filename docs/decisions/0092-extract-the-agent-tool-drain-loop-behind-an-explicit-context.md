# Decision 0092: Extract the agent tool-drain loop behind an explicit context

Status: **accepted and implemented**

Date: 2026-11-16 (Asia/Shanghai).

## Context

ADR 0091 deliberately left `drainToolCalls` inside `task-service.ts`, noting that extracting it without a context object would replace one large class with a large callback interface. This decision does the extraction properly.

The function was the densest part of the service: a 90-line loop interleaving approval checkpoints, read reuse, event recording, and message accumulation, all reaching through private members. Its ordering rules were security-relevant but only observable through a full task run, which meant they were effectively untested at the unit level.

## Decision

1. **An explicit context, not a callback soup.** `AgentLoopToolContext` names exactly what draining needs: the store operations it uses, the read cache, the resolved capabilities, and five recording hooks. Everything else stays with the service.
2. **The ordering is stated once, at the top of the module.** Unknown tool → recorded failure; consequential tool → pause before execution, with an already-applied write refused; identical read in the same attempt → reused; every outcome → exactly one tool message. Reading one comment now explains the whole loop.
3. **The service keeps `drainToolCalls` as a thin adapter.** It builds the context from its own members, so the loop's callers are unchanged and the service still owns when draining happens.
4. **The extracted function is tested directly.** Eight assertions cover the rules above, including that a retry does not reuse a previous attempt's read and that a raw tool error is not forwarded to the model.

## Options

### A. Pass the twelve private members as parameters

Consequences: the signature becomes noise and every new hook touches the caller. Rejected.

### B. Leave it in place

Consequences: the most security-relevant ordering rules stay unassertable in isolation. Rejected now that the context shape is clear.

### C. Move the whole Agent loop, not just draining

Consequences: the loop also owns provider streaming, budget accounting, and task transitions; moving it in one step would change too much at once. Deferred to a later slice, starting from this seam.

## Validation

- `tests/agent-loop-tools.test.ts`: eight ordering assertions, all passing.
- Failure injection: forcing the approval branch to be skipped made two assertions fail, confirming the tests are load-bearing rather than decorative.
- The full suite passes unchanged: 470 tests, no assertion edited.

## Consequences

- `task-service.ts`: 1312 → 1222 lines across ADR 0091 and this one.
- The tool-execution contract is now readable and testable in one file.
- Remaining in the service: provider turns, budgets, and lifecycle. The provider-turn extraction can reuse the same context pattern.
