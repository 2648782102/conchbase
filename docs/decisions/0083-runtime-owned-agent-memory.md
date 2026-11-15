# Decision 0083: Runtime-owned agent memory

Status: **accepted and implemented**

Date: 2026-11-16 (Asia/Shanghai).

## Context

The Boss Agent receives at most the last eight conversation messages plus a snapshot of current organization facts. That is enough within one thread and useless across projects: once a project is archived, everything the Boss learned about it disappears from its context. The user's core product requirement is a single conversation that remembers, so this is a correctness gap, not an optimization.

`docs/MEMORY_REFERENCE.zh-CN.md` records the external survey behind this decision. The useful consensus is:

- Codex reassembles context every turn from an ordered prefix and compresses old history into a labeled handoff summary rather than appending forever.
- Claude Code keeps a human-authored project memory that is loaded eagerly and a model-maintained index that points at detailed files loaded on demand.
- Durable memory must be explicit, auditable, and scoped; writing it on every turn produces noise.

## Decision

1. **Memory is a Runtime-owned resource, not a model-authored file.** Entries live in private SQLite through `OrganizationStore`, are written only by Runtime code, and are never a second filesystem source of truth.
2. **Three scopes.** `runtime` (applies to every conversation), `project` (tied to one `projectId`), and `agent` (tied to one `agentId`, used for workers the Boss hired). Each entry always has exactly one scope.
3. **Two levels: index and body.** Every entry has a short `title` plus a bounded `body`. Only a compact index from a bounded query is injected into a prompt; the body is available but is not inlined wholesale.
4. **Bounded injection, ordered by importance.** The prompt receives at most `MAX_INJECTED` entries, newest-first per scope, with every field length-capped. Memory injection can therefore never grow the prompt without bound.
5. **Writes happen at named moments only.** Accepted-memory writes occur at two points: project convergence (the close-out report becomes a project memory), and a conversational proposal the Runtime accepts. There is no per-turn auto-summarization.
6. **A conversational proposal is untrusted input.** The Boss may return an optional `memory` array of at most four entries. Each entry is validated by the same parser as any other write; `runtime` scope is refused, unknown fields are refused, and a malformed entry rejects the whole proposal. The Runtime additionally drops any entry whose project or agent target does not exist, so a memory can never describe something that was never there. The model proposes; the Runtime decides.
7. **Untrusted text stays untrusted.** A memory body passes the same secret-like filter as other published text, is stripped of control characters, and is rejected if empty or oversized. Memory never grants capability, never changes tool policy, and never authorizes an action.
8. **Memory is advisory context.** The prompt labels it as recollection that may be stale and instructs the Boss to verify against current organization facts before acting. A memory entry can never override a live `attention` or `worker` fact.
9. **Deletion is a first-class operation.** Entries can be removed by id; nothing else rewrites or tombstones silently. This keeps the record auditable and lets a user retract something wrong.

## Options

### A. Dump the whole organization event log into the prompt

Consequences: unbounded growth, no prioritization, and the Boss drowns in worker chatter. Rejected.

### B. Let the model maintain a memory file

Consequences: it is what Claude Code does well, but Conchbase has no repository boundary for it, the model output is untrusted here, and a private file would become a second writer beside SQLite. Rejected for now; a future ADR could expose an export.

### C. Summarize every turn into memory

Consequences: cheap to add, but produces hundreds of near-duplicate entries, burns storage, and makes recall worse. Rejected.

### D. Scoped, bounded, Runtime-written entries injected as a labeled index

Consequences: recall improves across projects, prompt size stays predictable, every entry is auditable and deletable, and the model still cannot write authority. Accepted.

## Limits

- Title 120 characters; body 2,000 characters.
- At most 12 entries injected, at most 24 per scope stored.
- Per-write deduplication by `(scope, key, title)`; an identical write is a no-op.
- Injection happens before organization facts so a live fact always wins on conflict.

## Validation

- `tests/agent-memory.test.ts` covers scoping, deduplication, bounds, secret-like rejection, deletion, and index rendering.
- `tests/boss-memory-write.test.ts` covers accepting a valid project proposal, refusing `runtime` scope and secret-like content, rejecting malformed shapes, and dropping a proposal aimed at a project that does not exist.
- Live probe (2026-11-16): a project converged, and a brand-new conversation recalled it — the Boss named the archived project, its worker, the quoted result, and offered resume/keep/new-goal options.
- A convergence fixture asserts the project close-out becomes exactly one project memory entry.
- `npm run check`, `npm test`, and `npm run build` are the required gate.

## Consequences

The Boss can recall what happened in previous projects without carrying the whole event log, and the same mechanism will serve worker Agents. No public path or schema changed; the private schema gains one additive table and `user_version` advances to `9`.
