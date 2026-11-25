# Boss Agent Continuous Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Boss Agent conversation continuous and non-blocking while workers and arbitrary roles execute in the background and report through durable Runtime events.

**Architecture:** Boss chat turns settle after delegation. A Runtime-owned async orchestrator waits for workers, records reports, and publishes Boss notices. Project facts carry bounded worker knowledge into later Boss turns; roles are data chosen by Boss Agent.

**Tech Stack:** TypeScript, Node.js test runner, SQLite organization/task stores, Fastify HTTP/SSE, React Pagurus client.

**Spec:** `docs/superpowers/specs/2026-11-25-boss-agent-continuous-orchestration-design.md`

## Global Constraints

- Node.js 24 or newer.
- Runtime remains authoritative; clients must not own task state.
- Preserve internal id `boss-agent`.
- Use durable organization events and reportText for worker results.
- No plaintext credentials in prompts, events, logs, or messages.
- Role names are model/Runtime data, not hard-coded hierarchy.
- Both repositories must pass `npm run check && npm test && npm run build`.

## Review Focus

- A worker running longer than the Boss model call must not keep the Boss chat message live.
- A second user message during worker execution must be accepted immediately.
- Worker failure, attention, and completion must be visible without overwriting previous Boss replies.
- Stale reports from old projects must not dominate current Boss context.
- Renaming display strings must not break the internal id or stored conversations.

---

### Task 1: Settle Boss chat turns before worker completion

**Files:**
- Modify: `src/runtime/agent-chat.ts`
- Modify: `src/runtime/boss-mode-service.ts`
- Test: `tests/agent-chat.test.ts`
- Test: `tests/boss-mode-service.test.ts`

**Interfaces:**
- Consumes: `BossModeService.submit(input, onAccepted?)`
- Produces: Boss chat assistant message reaches terminal state before worker task terminal state.

- [ ] **Step 1: Write a failing test with a gated worker provider**

In `tests/agent-chat.test.ts`, create a Boss parser that emits `open_project`, `activate_project`, and `create_agent`; make the worker provider promise never settle until the test releases it. Assert the assistant message becomes terminal while the worker task is still running, and a second user message is accepted without queuing.

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `node --import tsx --test tests/agent-chat.test.ts`
Expected: fails because the Boss message stays `organizing` or the second turn is queued.

- [ ] **Step 3: Add non-blocking Boss submission mode**

Add an option so `BossModeService.submit` can publish accepted state and schedule worker waiting asynchronously, returning before `collectWorkerOutcomes`. Keep worker execution and reports in the Runtime-owned runner. Boss chat uses this mode.

- [ ] **Step 4: Make Boss chat terminal on accepted**

In `postBossMessage`, use the accepted result as the Boss reply and settle the assistant message immediately. The later worker outcome must append/update durable organization facts, not rewrite the terminal Boss reply through `.then()`.

- [ ] **Step 5: Run focused tests and full Runtime checks**

Run: `node --import tsx --test tests/agent-chat.test.ts tests/boss-mode-service.test.ts && npm run check`
Expected: all pass.

- [ ] **Step 6: Commit**

Commit message: `feat: settle boss turns before workers finish`

### Task 2: Publish async worker progress notices

**Files:**
- Modify: `src/runtime/organization-convergence-runtime.ts`
- Modify: `src/runtime/agent-chat.ts`
- Test: `tests/agent-chat-runtime-notice.test.ts`
- Test: `tests/organization-convergence-runtime.test.ts`

**Interfaces:**
- Consumes: durable `organization.report_recorded` events and `reportText`.
- Produces: bounded Boss conversation notices for worker completion, failure, and attention.

- [ ] **Step 1: Write failing notice tests**

Assert that a terminal worker report creates one bounded Boss notice with report id/state and does not alter an existing terminal assistant message.

- [ ] **Step 2: Implement idempotent report-to-notice bridge**

Use `announceBossNotice` with stable idempotency keys derived from report id and state. Do not include raw report text longer than the existing notice bound.

- [ ] **Step 3: Run focused tests and full Runtime checks**

Expected: notices appear as separate messages; no duplicate notices on repeated sweeps.

- [ ] **Step 4: Commit**

Commit message: `feat: publish worker progress to boss conversation`

### Task 3: Add project facts and worker report promotion

**Files:**
- Create: `src/runtime/project-facts.ts`
- Modify: `src/runtime/organization-store.ts`
- Modify: `src/runtime/organization-store.sqlite.ts`
- Modify: `src/runtime/boss-organization-context.ts`
- Test: `tests/project-facts.test.ts`
- Test: `tests/boss-organization-context.test.ts`

**Interfaces:**
- Consumes: worker report text and project ids.
- Produces: `promoteProjectFact`, `listProjectFacts`, and bounded facts in Boss organization context.

- [ ] **Step 1: Write failing tests for bounded project facts**

Assert that secret-like report text is withheld, duplicate facts update instead of duplicate, and Boss facts include only the current active project's bounded facts.

- [ ] **Step 2: Implement durable project fact storage and promotion**

Store facts with project id, key, body, sourceReportId, createdAt, and updatedAt. Validate size and secret boundaries before persistence.

- [ ] **Step 3: Inject facts into Boss context**

Add a bounded `projectFacts` section to `BossOrganizationFacts` for active/resumed projects.

- [ ] **Step 4: Run focused tests and full Runtime checks**

- [ ] **Step 5: Commit**

Commit message: `feat: add project facts for boss context`

### Task 4: Make roles data-driven and PM-optional

**Files:**
- Modify: `src/runtime/organization-intent-parser.ts`
- Modify: `src/runtime/boss-mode-service.ts`
- Test: `tests/organization-intent-parser.test.ts`
- Test: `tests/boss-mode-service.test.ts`

**Interfaces:**
- Consumes: model-emitted `displayName`, `instructions`, `scope`, `capabilities`.
- Produces: arbitrary role creation without PM-specific branches.

- [ ] **Step 1: Write tests with non-PM role names**

Assert Boss can create `Researcher`, `Reviewer`, or `PM` purely as data and can later reuse/offboard any of them.

- [ ] **Step 2: Remove or guard any hierarchy assumptions**

Ensure no tests or Runtime branches require a PM role. Add prompt text stating role names are chosen by the Boss from the task.

- [ ] **Step 3: Run focused tests and full Runtime checks**

- [ ] **Step 4: Commit**

Commit message: `feat: make boss roles data-driven`

### Task 5: Rename user-facing identity to Boss Agent

**Files:**
- Modify: `src/runtime/agent-chat.ts`
- Modify: `src/runtime/organization-intent-parser.ts`
- Modify: `pagurus/src/**/*.tsx`
- Modify: `pagurus/src/**/*.ts`
- Modify: docs and tests with user-facing strings
- Test: `tests/repository-guardrails.test.ts`
- Test: `pagurus/tests/**`

**Interfaces:**
- Preserve: internal id `boss-agent`.
- Produces: user-facing strings use `Boss Agent`.

- [ ] **Step 1: Add a guardrail test**

Assert no user-facing source/test/doc strings contain `老板 Agent` outside historical fixtures that explicitly need old data.

- [ ] **Step 2: Replace display strings and prompts**

Replace user-facing text with `Boss Agent`; keep `BOSS_AGENT_ID = 'boss-agent'` and public id values unchanged.

- [ ] **Step 3: Run dual-repo full checks**

Runtime: `npm run check && npm test && npm run build`.
Pagurus: `npm run check && npm test && npm run build`.

- [ ] **Step 4: Commit and push both repos**

Commit message: `feat: unify Boss Agent identity`

## Final Verification

- Live: send a Boss message that dispatches a slow worker; second Boss message is accepted immediately.
- Live: worker completion appears as a separate Boss notice/report message.
- Live: next Boss turn uses latest report/project facts.
- Full checks on both repos pass and `main` branches are pushed.
