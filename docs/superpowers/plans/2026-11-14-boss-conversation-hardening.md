# Boss Conversation Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate pure Boss conversation from organization execution and close the state, context, identity, persistence, streaming, and UI issues exposed by the live conversation.

**Architecture:** Agent Chat remains the public conversation owner; a private SQLite store makes it durable. Boss chat parses through a streaming Runtime-owned brain first. Pure chat publishes only an Agent Chat message; action turns enter `BossModeService` for Runtime adjudication. Pagurus remains a renderer.

**Tech Stack:** Node.js 24+, TypeScript, Fastify, `node:sqlite`, Node test runner, Vitest, OpenAI-compatible SSE.

**Spec:** `docs/superpowers/specs/2026-11-14-boss-conversation-hardening-design.md`

## Global Constraints

- Keep `AGENTS.md`, `docs/AI_HANDOFF.md`, `docs/PROJECT_STATUS.json`, `docs/OBJECTIVE_MODE.zh-CN.md`, and `docs/AI_DEVELOPMENT.md` as the AI reading order.
- Keep the 47-path `1.0.0` contract and every accepted additive public path set frozen; no new public path or schema field.
- Keep Conchbase as the only execution authority; reparse every model-proposed action.
- Plaintext secrets, private paths, credentials, raw provider envelopes, and reasoning content never enter prompts, durable events, logs, errors, client responses, Agent revisions, configuration documents, or the UI.
- Use one SQLite owner; `PRAGMA user_version = 5` is private additive migration only.
- Run `npm run check`, `npm test`, and `npm run build` in both repositories.

## Review Focus

- Pure chat after a restart: conversation exists, terminal reply persists, no new organization event.
- In-flight assistant after a restart: becomes `unavailable` with a bounded error, never remains `organizing`.
- A model that returns valid JSON with identity/capability claims: normalization prevents false product identity or false external-query claims.
- A model that proposes an out-of-schema action: no organization mutation and `unavailable` is published.
- User asks what projects/workers do: prompt contains bounded project origin intents, worker display names, states, instructions, scope, capabilities, and the unsupported capability manifest.

---

### Task 1: Failing tests for separation, facts, streaming, and durability

**Files:**
- Create: `tests/agent-chat-store.test.ts`, `tests/boss-organization-context.test.ts`
- Modify: `tests/agent-chat.test.ts`, `tests/organization-intent-parser.test.ts`, `tests/boss-mode-service.test.ts`, `package.json`, guardrail tests, Pagurus UI tests.

**Interfaces:**
- Produces: `AgentChatStore`, `SqliteAgentChatStore`, `migrateAgentChatSchema`, `buildBossOrganizationFacts`, `BossConversationProgress`, pure-chat `source: 'agent-chat'`, stream progress callbacks, ADR 0050 / Pagurus ADR 0028.

- [ ] **Step 1: Write failing tests** for no-write pure chat, SSE progress, identity normalization, capability boundary, readable facts, durable recovery, and UI copy.
- [ ] **Step 2: Run targeted tests to verify they fail** because the new modules/exports/behavior do not exist.

### Task 2: Private durable Agent Chat store

**Files:**
- Create: `src/runtime/agent-chat-store.ts`
- Modify: `src/runtime/task-store.ts`, `src/runtime/platform-store.ts`, `src/runtime/organization-store.sqlite.ts`

**Interfaces:**
- Consumes: `DatabaseSync`, `AgentChatMessage` types.
- Produces: `AgentChatStore`, `InMemoryAgentChatStore`, `SqliteAgentChatStore`, `migrateAgentChatSchema`, `TaskStore.agentChat`.

- [ ] **Step 1: Implement** the store interface, in-memory and SQLite stores, and private `user_version = 5` migration.
- [ ] **Step 2: Run** `node --import tsx --test tests/agent-chat-store.test.ts tests/persistence-conformance.test.ts tests/organization-persistence.test.ts`.

### Task 3: Organization facts, streaming brain, and no-write conversation

**Files:**
- Create: `src/runtime/boss-organization-context.ts`
- Modify: `src/runtime/organization-intent-parser.ts`, `src/runtime/boss-mode-service.ts`, `src/runtime/agent-chat.ts`, `src/runtime/primary-conversation.ts`, `src/http/create-app.ts`, `src/cli.ts`, `src/main.ts`

**Interfaces:**
- Produces: `buildBossOrganizationFacts`, `BossOrganizationFacts`, `BossConversationProgress`, `source: 'agent-chat'`, `onProgress`, streaming SSE parser, Runtime-owned identity/capability normalization.

- [ ] **Step 1: Implement** bounded facts, stream parsing, pure-chat short circuit, progress state transitions, and durable Agent Chat service writes.
- [ ] **Step 2: Run** targeted parser, Boss service, and Agent Chat tests.

### Task 4: Pagurus copy/state and accepted ADR/docs

**Files:**
- Create: `docs/decisions/0050-boss-conversation-hardening.md`, `pagurus/docs/decisions/0028-boss-conversation-hardening-console.md`
- Modify: status, handoff, objective, API, OpenAPI descriptions, README, Chinese docs, guardrails.

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: accepted boundaries and machine-readable status/evidence.

- [ ] **Step 1: Implement** UI copy, ADRs, docs, guardrails, and status updates.
- [ ] **Step 2: Run** full dual-repository validation.

### Task 5: Final verification, live smoke, push

**Files:** validation and git operations only.

- [ ] **Step 1: Run** both repositories' `check/test/build`, `git diff --check`, and JSON parse.
- [ ] **Step 2: Restart Runtime**, smoke pure chat and capability-boundary chat against Magpie, then commit and push.
