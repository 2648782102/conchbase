# Decision 0093: Split contract validators and chat state derivation

Status: **accepted and implemented**

Date: 2026-11-16 (Asia/Shanghai).

## Context

Following ADRs 0090–0092, the two remaining files over 1000 lines were `organization-contract.ts` (1102) and `agent-chat.ts` (1091).

Both mixed two kinds of decision that change for different reasons:

- the organization contract mixed *field validation* (what a bounded, opaque, secret-free value looks like) with the *state machine* (what transition is legal right now);
- Agent Chat mixed *state derivation* (task state → what the user sees) with transport, persistence, and streaming.

## Decision

1. **`organization-validators.ts`** — the ~160 lines of field primitives: bounds, opaque grammars, scope and capability parsing, secret screening, canonical digests. `OrganizationValidationError` and `OrganizationModelReference` moved with them so the module has no dependency on the contract, which also removes an import cycle risk.
2. **`agent-chat-types.ts`** — the shared vocabulary (message state, phase, reasoning effort, activity kinds). A type-only module so both the derivation rules and the service can refer to the same unions without importing each other.
3. **`agent-chat-state.ts`** — the derivation rules: terminal and nonterminal sets, task-state mapping (including `done` for an unread success), phase grouping, provider-failure classification, and reasoning-effort parsing.
4. **The services keep thin wrappers where their error types matter.** `parseReasoningEffort` throws a transport-free error; Agent Chat wraps it so callers still receive `AgentChatServiceError`. Behaviour is preserved, not moved for its own sake.

## Validation

- `tests/organization-validators.test.ts`: 8 assertions over bounds, grammars, scope/capability rules, secret screening, and canonical identity.
- `tests/agent-chat-state.test.ts`: 8 assertions over the state mapping, terminal sets, phase grouping, failure classification, and effort parsing.
- Full suite unchanged at 486 tests.

## Correction recorded

Two of my initial assertions were wrong, and both were corrected against the implementation rather than the reverse: `parseScope` **rejects** duplicates instead of merging them, and a bare token like `anything` is a legal scope (only absolute paths and `..` are refused). Likewise `unavailableError` deliberately does not treat HTTP 429 as an unavailable provider — rate limiting is not a configuration fault. Writing the tests exposed misreadings that the service-level tests had never isolated.

## Consequences

- `organization-contract.ts`: 1102 → 955. `agent-chat.ts`: 1091 → 1039.
- Both files are now under 1000 lines; no runtime file exceeds it.
- The state mapping — the source of the recent `done`/`replied` regression — is now directly asserted rather than only observable through a full turn.
