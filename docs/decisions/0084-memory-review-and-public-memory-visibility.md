# Decision 0084: Memory review and public memory visibility

Status: **accepted and implemented**

Date: 2026-11-16 (Asia/Shanghai).

## Context

ADR 0083 shipped Runtime-owned memory with two write sources and a strict parser. Two problems remained, and they are the ones a user actually notices:

1. **Nothing checked intent.** The Boss may propose memory whenever it thinks the user asked to remember something. Models routinely mistake a one-turn format request ("this time, just give me the conclusion") for a lasting preference. Shape validation cannot catch that; the difference is semantic.
2. **Nothing was visible or retractable.** A memory entry had no provenance and no client surface. If the Boss remembered something wrong, the record was silently permanent. That contradicts the principle that memory must be explicit, auditable, and deletable.

## Decision

### Review is a recommendation, never an authority

1. **A separate review step judges intent only.** Given the user's message, the Boss's reply, and the existing titles, it answers one question per proposal: is this a lasting preference or a one-turn instruction? It returns `accept` or `reject` with a short reason.
2. **Runtime checks still run first.** Shape, scope, secret-like content, and target existence are decided before the reviewer is consulted. A reviewer cannot resurrect a refused entry, widen a scope, or grant anything.
3. **The reviewer is disposable, like any other worker.** It is a bounded, stateless completion with no tools, no durable identity, and no memory of its own. It exists for one review and is discarded, which matches the organization model without inventing a "reviewer" schema role.
4. **Configured-but-unavailable means drop, not write.** If a reviewer is configured and the call fails, the proposal is discarded. Falling back to an unreviewed write would silently defeat the reason the reviewer exists. Memory is advisory; the user can ask again.
5. **Without a reviewer, behaviour is unchanged.** The entry is still validated and written, marked `reviewedBy: "unreviewed"`. This keeps embedded and test deployments working.

### Memory becomes inspectable and retractable

6. **Every entry records provenance.** `sourceIntentId` ties an entry to the turn that produced it, and `reviewedBy` records whether an independent reviewer accepted it.
7. **Two additive public paths.** `GET /v1/memory` lists bounded entries with optional `scope` and `scopeId` filters; `DELETE /v1/memory/{memoryId}` removes one. There is no public write path: memory content can only enter through the Runtime's own validation, so a client cannot inject a fact.
8. **Deletion is real deletion with a retraction record.** The entry row is removed, and a tombstone for its `(scope, scopeId, key)` is kept in `agent_memory_tombstones`. The response reports whether anything was removed; a 404 means the id was never there or is already gone.
9. **Retraction is sticky for automatic writes.** Project convergence writes with `origin: "automatic"` and is rejected when the key is tombstoned. Otherwise deleting a project's summary would be undone by the next idle sweep, which would make deletion meaningless.
10. **A live, reviewed request may restore a key.** A conversational write uses `origin: "conversational"` and clears the tombstone, because the user asking again in a conversation is a new deliberate decision rather than a background process overriding them.

## Options

### A. Judge intent with keyword rules in the Runtime

Consequences: Chinese has no reliable marker separating "this time" from "from now on"; the rule would both over- and under-fire, and it puts a second decision-maker beside the model. Rejected.

### B. Let the reviewer persist directly

Consequences: the reviewer becomes a second writer whose mistakes are permanent, and a prompt-injected reply could write facts. Rejected.

### C. Keep memory private with no client surface

Consequences: the user has no way to see or correct what the assistant remembers, which is the failure mode the product is meant to avoid. Rejected.

### D. Reviewer recommends, Runtime decides, user can inspect and delete

Consequences: the hard semantic call gets a model, authority stays with the Runtime, and mistakes are visible and reversible. Accepted.

## Limits

- At most 4 proposals per turn; at most 4 decisions, each covering a distinct index.
- Reviewer reasons are capped at 200 characters and screened for secret-like content.
- Reviewer call timeout is 20 seconds and never streams.
- `GET /v1/memory` returns at most 200 entries and never returns transcript text.

## Validation

- `tests/memory-review.test.ts` covers accepted and rejected verdicts, mandatory full coverage, malformed verdict rejection, upstream failure returning null, provenance and review status on write, rejection not persisting, and an unavailable reviewer dropping rather than writing.
- `tests/memory-api.test.ts` covers listing, scope filtering, deletion, 404 on unknown ids, and the absence of any write path.
- `tests/agent-memory.test.ts` covers the tombstone rules: an automatic write cannot restore a retracted key, a conversational write can, and tombstones survive a SQLite reopen.
- `tests/boss-memory-injection.test.ts` proves a retracted entry disappears from the injected prompt index.
- `tests/organization-convergence.test.ts` proves a project still converges while its retracted memory stays deleted.
- `npm run check`, `npm test`, and `npm run build` are the required gate.

## Consequences

The Boss can still propose memory, but a wrong proposal is now (a) likely to be rejected on intent and (b) visible and deletable if it gets through. The memory contract gains an additive `1.9.0` section with two paths; the frozen `1.0.0` contract is untouched. The private schema gains two columns with safe defaults. `migrateOrganizationSchema` adds them idempotently, so the database stays at `user_version = 9` and an existing file opens without a migration step.

## Corrections recorded during live validation

1. **A live run failed with "resume_project is missing revalidatedDelegationId".** The model cannot know which Delegation the Runtime recorded, so `resume_project` now gets that id filled by the Runtime through a `project-delegation` field rule, and a supplied value is replaced rather than trusted. This is the same class as ADR 0074/0077: never reject a plan for a value only the Runtime can produce.
2. **Resuming a project wrote `worker_resumed` twice.** Project resume already restores its offboarded workers; a plan that also listed the explicit `resume_worker` applied it a second time. It is now an idempotent skip when the worker is no longer `offboarded`, matching how duplicate implicit authorize/start steps are handled.
3. **Live retraction probe.** With a 60s idle window: a project converged and wrote its summary memory; the entry was deleted through `DELETE /v1/memory/{memoryId}`; the project was resumed and converged again, and memory stayed at zero — the tombstone held.

