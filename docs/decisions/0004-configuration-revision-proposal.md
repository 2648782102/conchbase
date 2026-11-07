# Decision 0004: Configuration revision pinning (proposal)

Status: **proposed, not accepted as a public contract**

## Context

Accepted architecture says each task binds to one configuration revision for its lifetime; applying a new revision affects later tasks. Profile format, migration policy, and the exact active-revision API remain undecided.

The internal `src/runtime/configuration-revision.ts` treats portable profile, Skill, policy, and MCP-server identifiers as normalized ordered sets. A SHA-256 digest of a versioned canonical form yields a deterministic revision ID. Applying different content appends to an immutable in-memory history and changes the active revision; equivalent content is a no-op.

## Options

### A. Content-addressed immutable revisions (recommended)

- Normalize identifiers, hash a versioned canonical document, and pin tasks to the resulting ID.
- Active revision is a pointer; history is append-only.
- Reapplying identical content does not create a revision.

Consequences: deterministic, diffable, and cheap to test. It does not define portable file schemas, secret references, migrations, or rollback authorization.

### B. Sequential numeric revisions

- Increment an integer on every accepted apply.

Consequences: simple display, but identical applies create meaningless churn and replicas need a coordination source. Rejected as the identity model; a human-facing ordinal may be added later.

### C. Mutable active profile

- Mutate one profile document and point tasks at timestamps or snapshots.

Consequences: easy to start, but rollback, audit, and task pinning become ambiguous. Rejected because it undermines the accepted invariant.

## Recommendation

Keep option A internal for now. Before a write API, obtain product direction on profile/config schema, validation errors, revision display, rollback, import/export, secret references, and migrations. Pagurus must consume the future Conchbase contract; it must not copy this internal shape.

## Validation

`tests/configuration-revision.test.ts` covers canonical IDs, content changes, immutable active/history behavior, and no-op applies. `tests/task-lifecycle.test.ts` asserts that a task record preserves its initial configuration revision ID across transitions.
