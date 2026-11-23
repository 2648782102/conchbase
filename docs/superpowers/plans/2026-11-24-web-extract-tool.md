# Web Extract Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a bounded, opt-in `web_extract` tool that turns a public web page into untrusted plain text for the Agent without weakening the existing HTTP boundary.

**Architecture:** Refactor the existing `http_fetch` network pipeline into a shared internal fetch function, then add a second tool provider that applies a small HTML-to-text extractor and explicit secret/untrusted-data handling. Policy and side-effect bookkeeping keep their existing `external` path; approval display and capability default tests are included because they currently contain `http_fetch`-specific assumptions.

**Tech Stack:** Node 24 standard library, TypeScript, Node test runner.

**Spec:** `docs/superpowers/specs/2026-11-24-web-extract-tool-design.md`

## Global Constraints

- Use Node.js 24 or newer.
- Add no runtime dependency.
- `web_extract` is opt-in under the existing HTTP tool enable flag and shares the existing SSRF boundary, including redirect re-vetting.
- `web_extract` is `sideEffect: 'external'` and is not granted by any capability preset.
- `maxChars`: default 8,000, minimum 500, maximum 20,000; out-of-range values are refused.
- `linkLimit`: default 10, minimum 0, maximum 25; out-of-range values are refused.
- Raw response body cap stays 64 KiB; title cap 300 characters; link URL cap 500 characters.
- Fetch/argument failures use `ToolRejectedError`; extraction states are successful bounded results with `status` in evidence.
- Every model-visible string from the tool is checked with `containsSecretLike`; any match withholds the whole extraction.
- Extracted content is wrapped with explicit untrusted-data markers.
- `web_extract` accepts only `text/html`, `application/xhtml+xml`, `text/plain`, JSON, and XML content types.
- Approval display for a `url`-only external tool must show the tool id and target URL, and use external-action wording.
- No HTTP API or task-schema changes.

## Review Focus

- A hostile page with `ignore previous instructions` text must be wrapped as data and must not alter grants, policy, or tool execution.
- A secret-looking token in title, links, or body must not reach model context, evidence, or digest inputs.
- A redirect from a public host to loopback must remain refused on the second hop.
- Oversized HTML and long link lists must be bounded with explicit truncation status.
- Adding the tool must not change `http_fetch` behavior or grant `web_extract` implicitly.
- The built-in tool surface must expose `web_extract` only when `enableHttp` is true.

---

### Task 1: Shared bounded fetch pipeline

**Files:**
- Modify: `src/runtime/http-tools.ts`
- Test: `tests/http-tools.test.ts`

**Interfaces:**
- Consumes: existing `vetUrl`, `isForbiddenAddress`, `ToolRejectedError`, and `ToolExecutionResult`.
- Produces: an internal `fetchBoundedResource` function returning `{ body, bytes, truncated, contentType, status, finalUrl, redirects }` for textual responses, while `http_fetch` keeps its exact public behavior.

- [ ] **Step 1: Add failing tests that lock existing `http_fetch` behavior before refactor**

In `tests/http-tools.test.ts`, add tests named `http_fetch keeps returning raw textual bodies with evidence` and `http_fetch still refuses a redirect into loopback`. Assert that a plain `text/plain` body appears verbatim in `summary`, evidence contains `url`, `status`, `contentType`, `bytes`, `truncated`, and `redirects`, and a `302` to `http://127.0.0.1:4318/v1/tasks` rejects without a second fetch.

- [ ] **Step 2: Run focused tests**

Run: `node --import tsx --test tests/http-tools.test.ts`

Expected: new tests fail until the shared pipeline preserves the result fields; if they already pass, keep them as regression locks.

- [ ] **Step 3: Refactor `src/runtime/http-tools.ts`**

Extract the existing URL validation, redirect loop, textual content-type check, streaming body read, and final URL/evidence construction into one internal function used by `http_fetch`. Do not change accepted methods, status handling, error codes, or result shape.

- [ ] **Step 4: Run focused tests**

Run: `node --import tsx --test tests/http-tools.test.ts`

Expected: PASS, including all existing SSRF tests.

### Task 2: HTML extraction and safe result envelope

**Files:**
- Create: `src/runtime/web-extract.ts`
- Modify: `src/runtime/http-tools.ts`
- Test: `tests/web-extract.test.ts`

**Interfaces:**
- Consumes: `createBuiltinHttpTools`'s shared fetch pipeline options and `containsSecretLike` from `src/runtime/secret-filter.ts`.
- Produces: `createBuiltinWebExtractTool(options: WebExtractToolOptions = {}): ToolProvider`, with tool id `web_extract`, `sideEffect: 'external'`, and bounded arguments `{ url, maxChars?, linkLimit? }`.

- [ ] **Step 1: Write failing extraction tests**

Create `tests/web-extract.test.ts`. Add tests named:
  - `web_extract returns title, readable text, and absolute links`
  - `web_extract removes scripts, styles, hidden sections, comments, and unsafe links`
  - `web_extract treats extracted text as untrusted data`
  - `web_extract resolves relative links against the final URL after a redirect`
  - `web_extract refuses invalid maxChars and linkLimit`
  - `web_extract withholds secret-like output everywhere it could leak`
  - `web_extract handles empty, truncated, plain-text, and binary responses`
  - `web_extract refuses content types outside its extraction allowlist`

Use an injected fetch plus `resolve: async () => ['93.184.216.34']`; assert exact status values `ok`, `empty`, `too_large`, and `secret_withheld`; assert `maxChars`/`linkLimit` boundary values from the Global Constraints.

- [ ] **Step 2: Run focused tests to verify they fail**

Run: `node --import tsx --test tests/web-extract.test.ts`

Expected: FAIL because `web-extract.ts` does not exist.

- [ ] **Step 3: Implement `src/runtime/web-extract.ts`**

Implement the bounded HTML state machine from the design. Decode only the listed entities, collapse whitespace, strip disallowed sections, resolve safe relative links against the final post-redirect URL, and build the untrusted-data summary. Enforce the `web_extract` content-type allowlist separately from the broader `http_fetch` textual check. Check all model-visible strings, including evidence and error detail, with `containsSecretLike`; on any match return the sanitized `secret_withheld` result only.

- [ ] **Step 4: Wire the tool into the HTTP provider**

In `src/runtime/http-tools.ts`, expose both tools from `createBuiltinHttpTools` when HTTP tools are enabled, while keeping `http_fetch` unchanged and adding `web_extract` to `has`/`invoke` dispatch.

- [ ] **Step 5: Run focused tests**

Run: `node --import tsx --test tests/http-tools.test.ts tests/web-extract.test.ts`

Expected: PASS.

### Task 3: Capability defaults and documentation

**Files:**
- Modify: `tests/capability-presets.test.ts`
- Modify: `tests/tool-runtime.test.ts`
- Modify: `src/runtime/task-service.ts`
- Modify: `src/runtime/agent-chat.ts`
- Modify: `tests/runtime-config.test.ts` if the enabled-tool surface is asserted there
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/CURRENT_STATE.md`
- Modify: `docs/PROJECT_PLAN.md`

**Interfaces:**
- Consumes: `createBuiltinHttpTools` now exposes `web_extract`.
- Produces: documented tool behavior and a regression test that no capability preset grants `web_extract`.

- [ ] **Step 1: Write failing approval and opt-in tests**

Add `external approval shows the tool id and URL target` to `tests/agent-chat.test.ts` and `web_extract is exposed only when HTTP tools are enabled` to `tests/tool-runtime.test.ts`. Assert that a `url`-only pending `web_extract` approval has a readable target and external wording, and that `createToolRuntime` lists `web_extract` only when `enableHttp: true`.

- [ ] **Step 2: Write failing capability test**

In `tests/capability-presets.test.ts`, add `no capability preset grants web_extract`. Call `grantsForPreset` for all four presets with a provider containing `web_extract`, and assert no returned grant name is `web_extract`.

- [ ] **Step 3: Run focused tests**

Run: `node --import tsx --test tests/capability-presets.test.ts tests/tool-runtime.test.ts tests/agent-chat.test.ts tests/runtime-config.test.ts`

Expected: FAIL for the new preset test if implementation accidentally grants the tool; otherwise PASS.

- [ ] **Step 4: Implement approval display and opt-in wiring**

In `src/runtime/task-service.ts`, derive a bounded approval target from `url` when `path` is absent. In `src/runtime/agent-chat.ts`, extend the approval hint beyond `http_fetch` so any `external` tool uses external wording with its tool id. Verify `createToolRuntime` does not expose `web_extract` when `enableHttp` is false.

- [ ] **Step 5: Update documentation**

In `docs/ARCHITECTURE.md#tools`, add `web_extract` to the network row, describe extraction limits and untrusted-data markers, and state that it is not preset-granted. In `docs/CURRENT_STATE.md`, add web extraction to the tool list. In `docs/PROJECT_PLAN.md`, record this as a completed Phase 7 slice with owner, credential boundary, recovery path, audit evidence, and disable path.

- [ ] **Step 6: Run focused tests**

Run: `node --import tsx --test tests/capability-presets.test.ts tests/tool-runtime.test.ts tests/agent-chat.test.ts tests/runtime-config.test.ts`

Expected: PASS.

### Task 4: Full verification and contract guardrails

**Files:** No source changes expected.

**Interfaces:**
- Consumes: all changes from Tasks 1–3.
- Produces: verification output proving the Runtime still type-checks, tests, and builds.

- [ ] **Step 1: Run standard checks**

Run:
```bash
npm run check
npm test
npm run build
```

Expected: all pass; 932 pre-existing tests plus new web extraction tests.

- [ ] **Step 2: Review the final diff**

Run: `git diff --check && git status --short`

Expected: no whitespace errors, no credentials, no unrelated files, no changes to task or HTTP API contracts.
