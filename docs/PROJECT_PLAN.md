# Personal Agent project plan

This is the active plan for Conchbase and its paired Pagurus console. It is a
product plan, not a promise that every item must be implemented exactly as
written. When the real product teaches us something, update this document and
continue with the smallest useful slice.

## Product goal

Build a private, local-first personal Agent that feels dependable every day:

- the user can talk naturally to one assistant;
- the assistant can use a small set of useful tools safely;
- work can continue for a while without losing state;
- the user can inspect what happened and approve consequential actions;
- useful preferences and project facts survive restart;
- the system remains understandable, recoverable, and easy to develop with
  modest coding models.

## Product principles

1. **Personal before platform.** Optimize for one trusted user on one machine.
2. **Conversation before configuration.** The user should reach a useful answer
   quickly; advanced controls remain available but secondary.
3. **Runtime truth.** The Runtime owns state, permissions, execution, and the
   public contract. The UI presents and requests; it does not decide.
4. **Evidence before confidence.** The Agent should inspect files or state
   before claiming facts, and the UI should show bounded evidence for actions.
5. **Safe by default.** Reads may be convenient; writes, external calls, and
   destructive actions require an explicit policy path.
6. **Recoverable over magical.** Restart, cancellation, timeout, retry, and
   partial failure must be visible and deterministic.
7. **Small vertical slices.** Every feature should work through Runtime,
   persistence, client, tests, and documentation before the next feature.

## What “finished enough” means

The first major milestone is not “many integrations”. It is a daily-use local
assistant that can run for weeks without confusing the user or losing work.
It should have:

- one obvious chat entry;
- a clear setup check and a friendly offline/error screen;
- stable conversations and task history;
- bounded read tools and a safe write approval flow;
- explicit model/provider errors;
- durable memory with review and deletion;
- backup/export and a recovery command;
- a testable release/build path for the supported desktop environment.

## Phases

### Phase 0 — Make development reproducible

**Goal:** A lower-capability coding model can clone, install, run focused tests,
and understand the next task without reading the whole history.

Tasks:

- `P0.1` Require and verify Node 24 in CI and local startup diagnostics.
- `P0.2` Add one root-level paired development guide covering Conchbase and
  Pagurus commands, ports, fake provider use, and common failures.
- `P0.3` Add a `doctor` command or script that checks Node, database path,
  workspace path, Runtime port, provider gateway, and console connectivity.
- `P0.4` Make the focused test commands obvious and keep a short smoke test
  that starts the Runtime, calls health, creates one deterministic task, and
  shuts down cleanly.
- `P0.5` Keep the current entry documents short and remove obsolete process
  documents when they stop helping development.

Exit check: a fresh checkout can run one documented command sequence and a
coding model can choose a task in under ten minutes.

### Phase 1 — Harden the Runtime foundation

**Goal:** Restart and failure behavior are trustworthy before adding more
capabilities.

Tasks:

- `P1.1` Write a state-machine table for task, attempt, conversation message,
  work item, and approval states; identify illegal transitions.
- `P1.2` Add focused tests for cancellation races, timeout, duplicate retry,
  restart during each important phase, and late provider/tool results.
- `P1.3` Add a durable event replay test that proves no duplicate, gap, or
  backwards cursor after restart.
- `P1.4` Add database backup/export and restore validation for a temporary copy.
- `P1.5` Add migration tests from every currently supported schema version and
  a clear incompatible-database error.
- `P1.6` Decide and document the supported single-process operating model,
  then make diagnostics explain it instead of silently failing.
- `P1.7` Add bounded log/error categories with request/task/attempt IDs but no
  prompts, secrets, raw tool arguments, or model transcripts by default.

Exit check: forced interruption, retry, restore, and event replay all have
deterministic tests and readable user-facing outcomes.

### Phase 2 — Make model providers interchangeable

**Goal:** Magpie keeps working, but it is no longer woven through product
semantics.

Tasks:

- `P2.1` Define a small provider interface for catalog, text generation,
  streaming, cancellation, tool-call normalization, and error categories.
- `P2.2` Move provider-specific headers, URLs, and response parsing behind the
  adapter boundary.
- `P2.3` Normalize errors into unavailable, authentication, rate-limit,
  timeout, invalid-request, context-limit, and upstream-failure categories.
- `P2.4` Add a deterministic in-process fake provider used by all Runtime and
  paired tests.
- `P2.5` Add one second provider adapter or a local OpenAI-compatible adapter,
  whichever is most useful on the target machine.
- `P2.6` Show provider/model, latency, retryability, and bounded failure detail
  in Runtime diagnostics without exposing credentials.
- `P2.7` Add model capability metadata: streaming, tool calls, context size,
  reasoning support, and whether the model is suitable for Boss planning.

Exit check: switching provider changes configuration, not task/domain code;
both adapters pass the same contract tests.

### Phase 3 — Make the Agent useful and safe

**Goal:** The Agent can inspect, reason, act, and recover without becoming an
unbounded shell wrapper.

Tasks:

- `P3.1` Stabilize the built-in workspace tools: list, read, search, and bounded
  metadata. Add clear path, size, encoding, and timeout limits.
- `P3.2` Define tool result envelopes with status, evidence, truncation, and a
  user-readable summary.
- `P3.3` Make the Agent explain which tools it used and link each claim to
  bounded evidence where practical.
- `P3.4` Improve approval UX: show intent, target, arguments summary, risk,
  affected files, and the exact decision options.
- `P3.5` Add safe workspace writes with preview/diff, idempotency, approval,
  cancellation, and rollback guidance.
- `P3.6` Add a narrow process tool only if the personal workflow needs it; use
  fixed commands or an allowlist, never arbitrary shell by default.
- `P3.7` Treat tool output as untrusted content. Add prompt-injection fixtures,
  secret-like output fixtures, oversized-output fixtures, and path-escape tests.
- `P3.8` Add per-Agent capability presets that are understandable to the user:
  read-only, workspace editing, local commands, and external integrations.

Exit check: the Agent can complete a file inspection and an approved edit in a
temporary workspace, while unsafe variants fail closed and leave evidence.

### Phase 4 — Make memory and projects reliable

**Goal:** The assistant remembers useful preferences without becoming an
opaque or uncontrollable database.

Tasks:

- `P4.1` Define memory types: preference, project fact, instruction, decision,
  and temporary context. Keep scope explicit.
- `P4.2` Add a user-facing memory review list with source, date, scope, and
  delete/retract actions.
- `P4.3` Improve promotion rules so the model proposes memory but Runtime
  validates scope, size, duplicates, secret-like values, and provenance.
- `P4.4` Add compact retrieval with ranking, freshness, and a strict prompt
  budget. Never inject the entire memory store.
- `P4.5` Add project lifecycle views: active, waiting, completed, archived,
  and failed, with the next user action visible.
- `P4.6` Add a close-out summary and a user-controlled archive/export path.

Exit check: the user can see why a memory was used, remove it, restart, and
confirm that it stays removed.

### Phase 5 — Simplify Pagurus around the personal workflow

**Goal:** The console feels like a personal assistant, not an internal admin
dashboard.

Tasks:

- `P5.1` Make the Agent surface the default entry and keep the operator console
  as an advanced view.
- `P5.2` Add first-run setup: runtime check, provider check, workspace choice,
  default Agent, and a first successful message.
- `P5.3` Merge or hide duplicate concepts across Boss, Agent Chat, tasks, and
  organization screens where the user does not need both.
- `P5.4` Create one activity timeline for messages, tool calls, approvals,
  reports, errors, and user decisions.
- `P5.5` Improve small-screen and keyboard workflows, including focus recovery
  after streaming and approval dialogs.
- `P5.6` Add user-facing diagnostics and a copyable support bundle that excludes
  secrets, prompts, and private file contents.
- `P5.7` Keep advanced configuration, capability records, and SecretHandles
  accessible without making them the first-run experience.

Exit check: a new user can install, configure, send a message, approve a safe
edit, inspect the result, and recover from a disconnected Runtime without
reading documentation.

### Phase 6 — Operate the local product

**Goal:** The personal Agent is easy to run every day and safe to upgrade.

Tasks:

- `P6.1` Choose a packaging target: desktop wrapper, background service, or a
  well-documented local web process. Do not build all three at once.
- `P6.2` Add start/stop/status/log commands and graceful shutdown.
- `P6.3` Add automatic database backup rotation and restore instructions.
- `P6.4` Add versioned upgrade checks and migration rollback guidance.
- `P6.5` Add long-running soak tests for conversations, events, memory, and
  bounded work.
- `P6.6` Add optional authenticated remote access only after local operation is
  stable and the threat model is written in plain language.

Exit check: the user can upgrade without losing data, recover from a bad
runtime, and understand what the process is doing.

### Phase 7 — Optional integrations

Only start this phase after the core daily workflow is reliable.

Possible integrations, each as a complete vertical slice:

- local Git read/write with preview and approval;
- calendar and reminders;
- email or messaging drafts before sending;
- web search and page extraction with citation/evidence;
- external project trackers;
- additional model providers;
- plugin packages with manifest, permissions, isolation, and uninstall.

Every integration must define ownership, credentials, rate limits, failure
recovery, audit evidence, and a disable path before implementation.

## What not to do yet

- Do not build a cloud control plane before the local product is dependable.
- Do not add a generic unrestricted shell tool as a shortcut.
- Do not let model text directly mutate files, send messages, or change policy.
- Do not add a second client-side schema for Runtime state.
- Do not add a large framework or state library to solve a small local problem.
- Do not make an elaborate multi-Agent topology the main product before the
  single-Agent daily loop is excellent.

## Task template

When turning a task ID into an implementation prompt, copy this template:

```text
Task: <ID and title>
Goal: <one user-visible result>
Read: docs/START_HERE.md, docs/CURRENT_STATE.md, docs/PROJECT_PLAN.md,
      and the owning source/test files.
Change: <exact modules and contract impact>
Tests first: <focused test names or files>
Acceptance: <observable behavior, including failure/restart/security cases>
Commands: npm run check; npm test; npm run build
Do not: change unrelated behavior, expose secrets, or invent a second schema.
Report: changed files, checks, failures, and remaining risks.
```

## Current next task

Start with `P0.1`, then complete Phase 0 in order. After each task, update
`CURRENT_STATE.md` only if the actual product changed. Move to Phase 1 when a
fresh checkout can reliably run the documented smoke test.
