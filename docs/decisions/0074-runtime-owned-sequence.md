# Decision 0074: The Runtime fills `expectedSequence` before validation

Status: **accepted and implemented Runtime-owned sequence fill**

Date: 2026-11-15 (Asia/Shanghai).

## Context

The Boss conversation refuses an otherwise valid plan whenever the model omits `expectedSequence`:

```
create_agent is missing expectedSequence.
老板 Agent 提交失败。
```

That value is **not** the model's to supply. It is the authoritative organization event count, which only the Runtime knows. `parseStructuredResult` and the deterministic parser both overwrite it:

```ts
return actionAt(parseOrganizationAction(fillRuntimeDigests(normalized)), baseSequence + index);
```

But `parseOrganizationAction` validates **before** `actionAt` replaces the field, so a missing value throws first. The Runtime already knows the answer and then rejects the plan for not knowing it.

The prompt also tells the model to include `expectedSequence`, which is the wrong instruction: it invites a model to guess a value that the Runtime discards.

## Decision

1. Before `parseOrganizationAction` runs in either parser, every action receives the Runtime-computed sequence: `baseSequence + index`.
2. Validation then still enforces the field: a filled action is validated like any other, so the contract does not weaken.
3. The prompt no longer asks the model for `expectedSequence`. It states that the Runtime supplies it.
4. `model` references are handled the same way they already were: the Runtime replaces a malformed or missing reference with its resolved one, because a model cannot know the operator's configured model.
5. A model that supplies a **wrong** sequence is corrected, not rejected — the Runtime value is authoritative either way.

## Options

### A. Keep rejecting plans without `expectedSequence`

Consequences: a model that produces a correct plan fails on a field it was never able to compute correctly. Observed in live use. Rejected.

### B. Drop the field from the contract entirely

Consequences: `OrganizationAction` and the public event contract change, and replay semantics lose an explicit ordering guard. Too large a change for a fill-order bug. Rejected.

### C. Fill before validation, keep validating

Consequences: the Runtime supplies what only it knows, the contract still rejects genuinely invalid actions, and no public shape changes. Accepted.

## Validation

- `tests/organization-intent-parser.test.ts` asserts a structured action without `expectedSequence` parses successfully and receives the Runtime sequence.
- `tests/organization-intent-parser.test.ts` asserts a supplied but wrong sequence is replaced by the Runtime value.
- Live Boss probe: before the fix, a valid "create a project and hire a worker" plan failed with `create_agent is missing expectedSequence`; after the fix it proceeds to project creation and hiring.
- `npm run check`, `npm test`, and `npm run build` pass.

## Consequences

The Boss can act on a plan it expressed correctly without being punished for a field the Runtime owns. The ordering guard remains in the contract and in validation; only the responsibility for producing the value moves to the party that actually has it.
