# Current state

Updated: 2026-11-23

## Working today

- TypeScript runtime and CLI on Node.js 24+.
- Fastify HTTP API on loopback, with health/runtime discovery.
- SQLite persistence for tasks, Agent profiles/revisions, conversations,
  configuration revisions, organization state, work state, and events.
- Agent-backed tasks with pinned Agent revision, runtime configuration revision,
  provider/model, bounded loop budgets, cancellation, retry, and restart
  recovery/checkpoint behavior.
- Boss Mode: one primary conversation can plan projects, delegate bounded work,
  collect reports, surface Attention, and close out idle projects.
- Agent Chat with persisted messages, streaming projection, resumable SSE, and
  inline approval for the supported tool path. A waiting approval carries the
  Runtime-computed summary, risk, and bounded preview, so the client can show
  the change without a second lookup.
- A conversation message presents its task, so it follows the task across a
  retry: an interrupted reply shows as failed, and once the retried attempt
  succeeds the same message is re-projected to the real output. A message with
  no task (a queued turn) is the only one a restart marks failed on its own.
- One effective policy is published: `permissionLevel`, beside the legacy
  `executionMode` marked `executionModeIsLegacy`. They could disagree, so read
  the level.
- A conversation may pin its own level, but only stricter than the Runtime's —
  looser requests are clamped and the response reports what applied. The choice
  is fixed at creation and cannot loosen while an approval is pending; model and
  effort may change between turns, each reply keeping its `modelReference`.
- Prompts fit the window (`context-budget.ts`, 32k fallback) with reserved reply
  room and a visible `context_trimmed`; instructions are never dropped and the
  rest is summarised (`context-summary.ts`), else `summarized: false`.
- Transient provider failures retry with capped backoff (`provider-retry.ts`);
  auth, malformed requests, and context overflow still fail immediately.
- Agent Chat cancels via `POST …/cancel` (running or queued); direct
  conversations use memory — injected index plus reviewed proposals, agent scope
  only, fail-closed reviewer.
- `CONCHBASE_PLUGINS_DIR` installs plugins, namespaced by plugin id; a broken
  plugin is skipped and `close()` stops every subprocess.
- Recurring tasks via `/v1/schedules`; overlapping and missed runs are skipped,
  a schedule with a missing Agent disables itself.
- Attachments: images become content parts; text documents are inlined and
  labelled as data; PDF and other binary formats are refused.
- Tools cover read, search, write, delete, move, copy, git, opt-in `http_fetch`,
  bounded `web_extract`, and `git_push`, each bounded to the workspace or an
  explicit target; see `ARCHITECTURE.md#tools`.
- Runtime notices are authored `runtime`, not `assistant`, and are excluded from
  model context: they are the Runtime speaking and must not be replayed as one
  of the Agent's own turns. Only user turns and non-empty assistant turns reach
  the model.
- Approval requests name the tool, target path, and risk before anything runs.
- A failed task records a bounded `category` (`auth`, `rate-limit`, `timeout`,
  `unavailable`, `provider`, …) on its `task.failed` event, derived from the
  classified provider error rather than the message text.
- A restart re-admits tasks that were accepted but never started instead of
  stranding them as interrupted; concurrent execution is bounded by
  `CONCHBASE_MAX_CONCURRENT_TASKS` (default 4), with waiting tasks still queued
  and cancellable.
- A task that was mid-request when the process died is `interrupted`, not
  auto-replayed: the crash window cannot prove a write did not run, so
  recovery stays an explicit `retry` that starts a new attempt.
- Consequential tools record intent before they run, so a crash between the
  write and its event leaves a durable `unknown` instead of a silent duplicate.
  This covers both the normal loop and the approval-resume path; `unknown`
  fails with a readable reason and recovery is an explicit `retry`.
- User-facing capability presets: read-only, workspace-editing, local-commands,
  external-integrations. There is deliberately no arbitrary-shell tool; the
  only subprocess tools are fixed read-only git commands.
- Optional MCP/Skill providers, bounded plugin/subprocess seams, and
  runtime-wide restricted/unrestricted execution modes. MCP tools discovered
  without a declared side effect default to `external` (approval + side-effect
  ledger); read-only must be opted into per server.
- Pagurus-compatible API for Agent editing, tasks, organization views,
  execution views, work controls, capability records, and write-only
  SecretHandles.

## Important limitations

- This is still a local personal product. It has no polished installer or
  production remote pairing experience. Background lifecycle is script-level
  (`start`/`stop`/`status`/`logs`), not an OS service. Backups now run on a
  timer (default daily, 7 kept, `CONCHBASE_BACKUP_INTERVAL_MS=0` disables) on
  the live connection, alongside the manual `backup`/`verify-backup`/
  `restore-backup` verbs. Restore validates before replacing and keeps the
  previous database file.
- SQLite has a single runtime owner. Multi-process operation and broad crash
  testing are not complete product features.
- Magpie is the only gateway exercised against a real service. The provider
  contract, registry, error classification, capability metadata, and fake
  provider exist. `openai-compatible` has its own endpoint and catalog via
  `CONCHBASE_PROVIDER_ENDPOINTS`; `npm run probe:provider` checks its catalog,
  streaming, and failure classification with injected-fetch tests. A live run
  is still pending.
- External side effects are intentionally narrow. Do not assume that a
  capability record or approval record means arbitrary host execution is safe.
- Pagurus is feature-rich but still exposes too many operator-oriented screens
  for a personal assistant. Simplifying the main user journey is planned.
- Real-browser accessibility, packaging, upgrade testing, and long-running
  soak tests need more coverage.

## Source map

- Runtime bootstrap: `src/cli.ts` (the only process entry point)
- HTTP registration: `src/http/create-app.ts`
- Tasks and persistence: `src/runtime/task-service.ts`, `task-store.ts`
- Agent loop/tools: `src/runtime/agent-chat.ts`, `agent-loop-tools.ts`,
  `tool-runtime.ts`
- Boss/organization: `src/runtime/boss-mode-service.ts` and the
  `organization-*` modules
- Contracts: `src/runtime/*-contract.ts`, `src/http/routes/v1/`,
  `docs/openapi.yaml`
- Tests: `tests/`, especially the focused test named by the task

## How to update this file

Change this file only when a capability becomes usable, is removed, or its
limitation changes materially. Do not turn it into a changelog. Use release
notes for historical detail.
