# Decision 0085: Memory scope promotion needs independent confirmation

Status: **accepted and implemented**

Date: 2026-11-16 (Asia/Shanghai).

## Context

ADR 0083 shipped three memory scopes but only two write paths, and ADR 0084 forbade the Boss from proposing `runtime` scope at all. The result was a dead end: `runtime` memory was read into every prompt but had no legal writer, and a live Boss correctly told the user "tell me and I'll make it global" about a capability that did not exist.

The reason for the original prohibition is sound. A project detail promoted to `runtime` leaks into every other conversation, and that is exactly the failure mode the scoped design exists to prevent. The prohibition was too blunt, though: "always answer conclusion-first" genuinely is a runtime-wide preference, and users do ask for it.

## Decision

1. **The Boss may propose `runtime` scope.** Parsing accepts it like any other proposal. Proposing is not granting.
2. **Promotion requires an explicit reviewer confirmation.** The reviewer must return `runtimeScopeConfirmed: true` for that entry, and it is instructed to default to rejection unless the user said something equivalent to "all projects" or "from now on". `accept` alone is not enough.
3. **No reviewer means no global memory.** With no independent check available, a runtime-scope proposal is dropped. This is stricter than project scope, where the pre-reviewer behaviour is preserved.
4. **A confirmation alongside a rejection is discarded.** Confirmation is only meaningful as a qualifier on acceptance.
5. **An unconfirmed proposal is dropped, not downgraded.** Silently rewriting `runtime` into `project` would guess at the user's intent and hide the model's mistake; dropping keeps the outcome honest and observable.

## Options

### A. Keep `runtime` unwritable

Consequences: the scope exists in the type system and the prompt but can never hold anything, and the Boss promises a capability that does not exist. Rejected.

### B. Let an accepted proposal promote itself

Consequences: "this is a durable preference" and "this applies to everything" are different claims; accepting the first and inferring the second is how one project contaminates all others. Rejected.

### C. Downgrade unconfirmed runtime proposals to project scope

Consequences: it looks helpful, but it silently changes what the user asked for and hides a model error. Rejected.

### D. Explicit model proposal plus explicit reviewer confirmation

Consequences: promotion happens when it is both requested and independently checked, and everything else fails closed. Accepted.

## Validation

- `tests/boss-memory-write.test.ts` asserts parsing accepts a runtime proposal without granting it.
- `tests/memory-review.test.ts` covers confirmation surviving parsing, a confirmation attached to a rejection being discarded, writing only with confirmation, no write without confirmation, and no write without a reviewer.
- Live probe (2026-11-16): asking "以后所有项目都这样" produced one `runtime` entry with `reviewedBy: accepted` and provenance; a brand-new conversation answered conclusion-first, proving cross-conversation effect. Asking "这个项目以后…" produced only a project-scope entry, leaving the global one untouched.

## Consequences

The dead scope is closed and the Boss can keep a genuine cross-project preference, but only when the user asked for it and an independent reviewer agreed. The default remains fail-closed: unclear intent yields no global fact. A defect found during this work — the reviewer's own vocabulary omitted `runtimeScopeConfirmed`, rejecting every legitimate confirmation — is covered by a regression test.
