# Boss Conversation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make 老板 Agent chat naturally through the configured model while preserving Runtime-only organization authority.

**Architecture:** Add a Runtime-owned conversational OrganizationIntentParser that emits strict JSON with a natural `reply` plus optional actions. Agent Chat supplies bounded conversation context; BossModeService validates and commits actions; the natural reply becomes the published assistant message.

**Tech Stack:** Node.js 24+, TypeScript, Node test runner, Fastify, existing OpenAI Chat Completions-compatible fetch adapter.

**Spec:** `docs/superpowers/specs/2026-11-14-boss-conversation-design.md`

## Global Constraints

- Keep the four frozen `1.5.0` Agent Chat paths and published message fields unchanged.
- Keep Conchbase as the only execution authority; reparse every model-proposed action.
- Never expose SecretHandle plaintext to a model, client, event, log, error, configuration document, or generic resolver.
- Never execute a tool outside the runtime policy and approval path.
- Magpie remains a user-configured OpenAI-compatible protocol endpoint.
- Run `npm run check`, `npm test`, and `npm run build` in both repositories.

## Review Focus

- A model returns plain text instead of strict JSON: assistant must become `unavailable`, not fixed content.
- A model proposes a valid-looking action with a bad identity or capability: Runtime must reject before commit.
- A model reply contains secret-like text: it must not reach the client, event log, or organization state.
- A natural question must not mutate projects/workers or create a normal Agent task.
- Upstream provider failure must classify as `unavailable` with a bounded error.

---

### Task 1: Conversational parser and context contract

**Files:**
- Modify: `src/runtime/organization-intent-parser.ts`
- Modify: `src/runtime/boss-mode-service.ts`
- Modify: `src/runtime/agent-chat.ts`
- Modify: `src/config/runtime-config.ts`
- Modify: `src/cli.ts`, `src/main.ts`
- Test: `tests/organization-intent-parser.test.ts`, `tests/agent-chat.test.ts`, `tests/runtime-config.test.ts`

**Interfaces:**
- Consumes: `OrganizationIntentParserInput`, `OrganizationIntentParseResult`, `BossModeSubmitInput`, `BossModeService.submit`.
- Produces: `conversation?: readonly { author, body }[]` on parser input/submission; `BossConversationParser` compatible with `OrganizationIntentParser`; `CONCHBASE_BOSS_MODEL` config.

- [ ] **Step 1: Write failing tests** for natural reply, action proposal, strict output validation, secret-like reply, provider failure, conversation context, and config parsing.
- [ ] **Step 2: Run tests to verify they fail** with `node --import tsx --test tests/organization-intent-parser.test.ts tests/agent-chat.test.ts tests/runtime-config.test.ts`.
- [ ] **Step 3: Implement** the strict conversational parser, bounded context plumbing, config field, and startup wiring.
- [ ] **Step 4: Run tests to verify they pass** with the same command, then full repository checks.
- [ ] **Step 5: Commit** with `git commit -m "feat: give Boss Agent natural model replies"`.

### Task 2: Accepted ADR and documentation

**Files:**
- Create: `docs/decisions/0049-boss-conversation.md`
- Create: `pagurus/docs/decisions/0027-boss-conversation-console.md`
- Modify: status, handoff, objective, API, README, Chinese release notes, guardrail tests.

**Interfaces:**
- Consumes: Task 1's implemented behavior and unchanged public contract.
- Produces: explicit accepted boundaries and machine-readable status entries.

- [ ] **Step 1: Write failing guardrail assertions** for the new ADR, status evidence, and docs.
- [ ] **Step 2: Run guardrail tests to verify they fail**.
- [ ] **Step 3: Implement** the ADRs and documentation updates.
- [ ] **Step 4: Run both repositories' full checks** and verify all three commands pass.
- [ ] **Step 5: Commit** with `git commit -m "docs: record Boss conversation boundary"`.

### Task 3: Verification and push

**Files:**
- No source files; validation and git operations only.

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces: verified, pushed `main` in both repositories.

- [ ] **Step 1: Run** `npm run check`, `npm test`, `npm run build` in Conchbase and Pagurus.
- [ ] **Step 2: Review** `git diff --check`, statuses, and final diff summary.
- [ ] **Step 3: Commit and push** both repositories.
