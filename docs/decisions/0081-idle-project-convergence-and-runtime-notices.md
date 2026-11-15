# Decision 0081: Idle project convergence and Runtime notices

Status: **accepted and implemented**

Date: 2026-11-15 (Asia/Shanghai).

## Context

ADR 0030 and ADR 0033 accepted the product shape "one primary conversation, projects that quiet down, archived work that can resume" and the lifecycle `idle -> report -> archive -> offboard`. The domain kernel, persistence, Boss bridge, and public projection were all implemented, but nothing ever *observed idleness*: a project only quieted or archived if a model explicitly emitted `quiet_project` or `archive_project`. In practice a finished project stayed `active` forever, its workers kept their delegations, and the user's single conversation never received the closing summary the product promises.

That gap is the difference between "the model can call archive" and "the Runtime runs the loop".

## Decision

1. **The Runtime observes idleness itself.** A `ProjectConvergenceService` periodically fingerprints each project from durable state — event count, last event sequence, worker states, report states, attention states. Any change resets that project's idle clock. Nothing is inferred from model prose.
2. **The first observation only arms the clock.** A project cannot be archived on the first sweep that sees it, so a restart or a newly discovered project never closes immediately.
3. **Convergence is refused while work is live.** An open `AttentionRequest`, a nonterminal Task bound to the project, or any activity inside the window keeps the project active. A false negative only delays cleanup; a false positive would archive work the user still wants.
4. **The action order is offboard, quiet, archive.** The domain rejects archiving a project that still has active workers, so the order is a correctness requirement rather than presentation. Every action goes through the existing validated store; convergence is not a second writer.
5. **The summary is derived, not invented.** It is built from the durable report ledger and stored report bodies, before the offboard mutates worker state. No extra model call is made, and missing bodies are stated as missing rather than fabricated.
6. **The Runtime may speak once into the Boss conversation.** `AgentChatService.announceBossNotice` appends a bounded, screened, idempotent notice. It accepts only a Boss conversation, so a Runtime notice can never masquerade as an ordinary Agent reply, and a repeated sweep cannot duplicate the message.
7. **Announcements are best-effort.** If the user never opened a Boss conversation, no conversation is created just to hold a notice. If publishing fails, the archive still stands: the durable organization events remain the source of truth.
8. **History is preserved.** Offboarding revokes authority; it never deletes events, reports, outputs, or decisions.

## Options

### A. Let the Boss model decide when a project is idle

Consequences: it costs a model call per check, produces different answers for identical state, and lets prose define a retention policy the Runtime is supposed to own. ADR 0030 already rejected this. Rejected.

### B. Archive immediately on the first quiet sweep

Consequences: a restart or a newly loaded project would archive before the user sees it, which is indistinguishable from data loss from the user's point of view. Rejected.

### C. Converge even with an open question or running task

Consequences: it would cancel work the user is waiting on and discard a question they were asked. Rejected.

### D. Observe durable state, refuse while live, then offboard/quiet/archive

Consequences: deterministic, restart-safe, and reuses the accepted domain transitions. Requires an explicit idle policy and a bounded notice channel, both added here. Accepted.

## Limits

- Default idle window: 30 minutes of no observable project activity. It is a policy value in `organization-convergence.ts`, not a model-controlled or per-task setting.
- Sweep interval: 60 seconds.
- Default: an open Attention request blocks convergence.
- A notice is capped at 4,000 characters and passes the same secret-like filter as other published text.
- Convergence applies only to `active` and `resumed` projects.

## Validation

- `tests/organization-convergence.test.ts` covers refusal while work is active, refusal with an open attention, refusal for an already archived project, the offboard/quiet/archive order, exactly-once convergence, activity resetting the idle clock, and summary contents.
- `tests/organization-convergence-runtime.test.ts` covers a real archive plus one Runtime notice carrying the stored report body.
- `tests/organization-store.test.ts` pins report-body parity between the in-memory and SQLite stores; the absence of that parity was a real defect found while writing this slice.

## Consequences

The product loop now closes without user action: a finished project quiets, reports once, archives, and releases its workers, and the user's single conversation receives a short, evidence-based summary. Resuming still requires revalidation through the existing `resume_project` path. No public path or schema changed, so this is an internal Runtime behavior; a client that wants to display convergence can read the existing organization events and recorded reports.

## Corrections recorded during implementation

1. **The idle clock was not actually used.** The first version computed an idle duration from event sequences, which cannot know when an event happened, so a project could look infinitely idle. The sweeper's observed activity time is now passed explicitly, and `new activity resets the idle clock` fails without it.
2. **The summary was built after the offboard.** Offboarding changes worker state, so summarizing afterwards described the project as it no longer was. The summary is now derived from the pre-convergence snapshot.
3. **The in-memory store silently lost report bodies.** `SqliteOrganizationStore` implemented the optional `recordReportText`/`reportTexts` pair; the in-memory store did not, so every summary said "body not retained". Both stores now behave the same and a test pins the parity.
4. **Two `AgentChatService` instances split the conversation cache.** The live probe archived the project correctly and wrote the notice, but the user's conversation never showed it: `main.ts` built one instance for the HTTP routes and another for the sweeper. Startup now constructs exactly one instance and passes it to both, and a test asserts both entry points keep that invariant.
