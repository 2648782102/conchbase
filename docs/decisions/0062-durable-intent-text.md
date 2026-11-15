# Decision 0062: Durable intent text and Boss project creation

Status: **accepted and implemented durable intent text and Boss project creation**

Date: 2026-11-15 (Asia/Shanghai).

## Context

ADR 0045 intentionally kept user intent text in an in-process map and published a digest-only placeholder after restart. That was acceptable for a projection-only slice, but the live Boss conversation depends on it: when the map is lost, `buildBossOrganizationFacts` falls back to "来源意图未在当前进程内保留", and the Boss cannot say what an existing project is for. Live testing showed the Boss repeatedly telling the user it could not recover project goals after a restart.

Separately, the Boss claimed it could not create a project. `open_project` was already an accepted action and already listed in the prompt, but nothing told the model that it may generate the `projectId` itself, so it declined instead of acting.

## Decision

1. Private SQLite gains one additive table `organization_intent_texts(intent_id, body, recorded_at)`. It stores bounded user intent text for the primary conversation and for Boss intents that produce organization actions.
2. `OrganizationStore` gains optional `recordIntentText` / `intentTexts` members. `SqliteOrganizationStore` implements them; `InMemoryOrganizationStore` keeps working unchanged so fixtures are unaffected.
3. `PrimaryConversationService` accepts an optional persistence adapter. When present, reads merge durable text first and the in-process map second; writes go to both, and a persistence failure never breaks the request.
4. `BossModeService` writes intent text through the same adapter and prefers durable text when building organization facts, so a restarted Runtime can still explain existing projects.
5. The Boss prompt now states explicitly that the model may create a project with `open_project` by generating a stable `projectId` (for example `project_<short-slug>`) and setting `originTriggerId` to the current `intentId`, followed by `activate_project`; it must not claim it is unable to create projects.
6. The prompt also states that `expectedSequence` equals the current organization event count and increments per action inside one reply.
7. No public path or schema changes. Text is still bounded, control characters are stripped, and secret-like content is rejected before storage.

## Options

### A. Keep process-scoped intent text

Consequences: the Boss permanently forgets project goals after every restart. Rejected.

### B. Ask the user to restate goals each session

Consequences: pushes a Runtime durability bug onto the user and breaks the product promise of one persistent Boss conversation. Rejected.

### C. Persist bounded intent text and teach the Boss to open projects

Consequences: project goals survive restarts and the Boss stops refusing a supported capability. Accepted.

## Validation

- `tests/organization-persistence.test.ts` records intent text, reopens the database, and asserts the text survives.
- Live verification: the Boss created `project_persist_intent_text`, the Runtime was restarted, and the Boss then quoted the stored goal verbatim.
- `npm run check`, `npm test` (260), and `npm run build` pass.

## Consequences

Project purpose survives restarts, so the Boss can answer "what is this project for" with real text instead of a placeholder. Storage stays bounded and local; no model or client gains new authority, and organization actions remain fully validated.
