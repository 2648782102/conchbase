# Decision 0077: One declarative contract for Runtime-repaired action fields

Status: **accepted and implemented declarative action contract**

Date: 2026-11-15 (Asia/Shanghai).

## Context

Every live failure across several sessions had the same shape: the Boss produced a coherent plan, and the Runtime rejected one action for a field only the Runtime could produce.

The fixes accumulated as special cases:

```ts
if (type === 'create_agent') { /* fill scope and capabilities */ }
if (type === 'report_worker') { /* default state */ }
for (const field of DIGEST_FIELDS[type] ?? []) { ... }
for (const field of RUNTIME_ID_FIELDS[type] ?? []) { ... }
```

A live run then produced three more of the same kind in one session: `report_worker is missing state`, `instructionsDigest must be an opaque digest`, `scope must contain 1 to 32 entries`, `capabilities[0] is not a bounded capability token`, `create_agent is missing model`.

Each was repaired individually. That is the actual defect: **there was no single place that answered "what may a model omit?"**, so every new action or field created a new opportunity to forget.

## Decision

1. `src/runtime/organization-action-contract.ts` declares, per action type, which fields the Runtime owns and how to fill them. Fillers are a closed set: `runtime-id`, `runtime-digest`, `runtime-sequence`, `project-scope`, `default-capability`, `enum`, `default-number`, and `resolved-model`.
2. Repair runs once, before validation, for both parser entry points. Validation is unchanged and remains the sole authority for what a valid action is.
3. A supplied value for a Runtime-owned field is **replaced**, not trusted. A digest, an opaque id, or the event sequence is not something a model can compute or invent.
4. A field whose value is a closed vocabulary (`state`, `capability` tokens) is repaired rather than rejected: an unacceptable token is dropped and the safe default applies.
5. `tests/organization-action-contract.test.ts` asserts, for every action with rules, that a **minimal** action — only the fields a model can meaningfully supply — is repaired into an action the real `parseOrganizationAction` accepts. A rule table that drifts from the validator fails that test rather than a live session.
6. The test also fails if an action gains rules without gaining a minimal fixture, so new fields cannot be added without stating what a model may omit.

## Options

### A. Keep patching each failure as it appears

Consequences: the observed pattern continues indefinitely, and each fix is only discovered in production. Rejected.

### B. Make every field optional and default everything

Consequences: the contract stops meaning anything; an action missing a genuinely required user intent would execute on a guess. Rejected.

### C. Declare the repair surface, and test it against the real validator

Consequences: one table answers the question, adding a field forces a decision, and the table cannot silently diverge from validation. Accepted.

## Validation

- `tests/organization-action-contract.test.ts` covers all seven repaired actions, replacement of model-supplied Runtime values, capability filtering, deterministic replay, and a closed-loop check against `parseOrganizationAction`.
- The closed-loop test caught three real mistakes in this change itself (`request_attention` has no `state`, attention actions have no `decision`, `create_agent` requires `model`), which is direct evidence it works.
- Live run after the change: the Boss built a `dupefinder` CLI with no field-repair failures. The produced tool was executed against a fixture tree and correctly grouped three identical files across a subdirectory, reporting 26 B recoverable.
- `npm run check`, `npm test` (339), and `npm run build` pass.

## Consequences

A model is no longer punished for omitting something it could not know, and adding a Runtime-owned field is now a visible, tested decision instead of an unmarked trap.

This does not make the Boss correct. It removes one whole class of failure — the one that was responsible for every observed "missing field" crash — and leaves the remaining classes visible rather than buried under it.
