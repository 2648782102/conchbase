# Current state

Updated: 2026-11-19

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
- Built-in workspace read/search tools with a depth cap, a search-time budget,
  UTF-8-safe truncation, and structured evidence on every result.
- Safe workspace writes: an existing file needs an explicit `overwrite: true`,
  and each result reports created-vs-replaced and byte sizes.
- Approval requests name the tool, target path, and risk before anything runs.
- User-facing capability presets: read-only, workspace-editing, local-commands,
  external-integrations. There is deliberately no arbitrary-shell tool; the
  only subprocess tools are fixed read-only git commands.
- Optional read-only MCP/Skill providers, bounded plugin/subprocess seams, and
  runtime-wide restricted/unrestricted execution modes.
- Pagurus-compatible API for Agent editing, tasks, organization views,
  execution views, work controls, capability records, and write-only
  SecretHandles.

## Important limitations

- This is still a local personal product. It has no polished installer or
  production remote pairing experience. Background lifecycle is script-level
  (`start`/`stop`/`status`/`logs`), not an OS service; backup/verify/rotation and
  project export exist but there is no scheduled automatic backup.
- SQLite has a single runtime owner. Multi-process operation and broad crash
  testing are not complete product features.
- Magpie is the only fully exercised model gateway. A provider contract
  (`model-provider.ts`), a provider registry, error classification, capability
  metadata, and a deterministic fake provider exist; a second real adapter still
  needs live contract tests.
- External side effects are intentionally narrow. Do not assume that a
  capability record or approval record means arbitrary host execution is safe.
- Pagurus is feature-rich but still exposes too many operator-oriented screens
  for a personal assistant. Simplifying the main user journey is planned.
- Real-browser accessibility, packaging, upgrade testing, and long-running
  soak tests need more coverage.

## Source map

- Runtime bootstrap: `src/main.ts`, `src/cli.ts`
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
