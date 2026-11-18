# Live user acceptance (blind-agent method)

This records a repeatable way to test whether the Runtime is actually usable,
independent of the deterministic suite and the live eval harness. It is a
**method and evidence record**, not a public contract.

## Method

1. Start a clean Runtime on an ephemeral port with its own database, connected
   to a live Magpie gateway (`CONCHBASE_MAGPIE_URL`, default `127.0.0.1:3425`):
   ```sh
   CONCHBASE_PORT=4320 CONCHBASE_DB=/tmp/<run>/runtime.sqlite \
     CONCHBASE_DEFAULT_MODEL=<model> CONCHBASE_BOSS_MODEL=<model> \
     node dist/cli.js serve
   ```
2. Give an independent coding agent **only the base URL** and a short list of
   user-style tasks. Do not tell it the route surface, the architecture, the
   Agent Chat model, or any known issues. Ask it to explore via `GET /` and curl
   and to report what it observed, including confusion and errors.
3. Ask for: multi-turn memory, an open-ended planning answer, a multi-worker
   organization task, a real tool call, invalid model, and invalid input type.
4. Triage every finding: distinguish a real defect from a tested-wrong-surface
   false positive and from an environment artifact (e.g. CLI and serve given
   different `CONCHBASE_DB`).
5. Fix real defects with a deterministic regression test, then **repeat the
   blind run** on a fresh agent against the fixed Runtime and compare verdicts.

## Evidence (2026-11-19)

- Deterministic suite: `npm run check`, `npm test` (567), `npm run build`, and
  `npm run test:audit` (no untested runtime modules) all green.
- Live eval harness: `npm run eval` — 6/6 tasks passed against a real model
  (inventory, refactor, boundary-escape, long-chain, insufficient-budget,
  context-switch).
- Boss organization path: a real Boss turn admitted two workers concurrently,
  both reported, and the reply summarized real outcomes.

### First blind run (before fixes)

The agent could not find the stateful entry point and used `POST /v1/tasks` and
`cli boss`, which are intentionally single-shot. It reported no memory,
CLI/HTTP storage isolation, no discoverable API, `prompt: 123` accepted, and
unknown models accepted then failing asynchronously. Overall verdict:
**not usable as an assistant.**

Triage:
- *False positive*: "no memory" — `POST /v1/agent-chat/conversations` +
  `/messages` keeps multi-turn context (verified: a lucky number survived two
  turns). The agent never found that surface.
- *Environment artifact*: "CLI vs HTTP storage" — the test serve used an
  explicit `CONCHBASE_DB` while CLI used its default; with one DB path the
  single-owner design is intentional.
- *Out of scope*: model self-identification and garbled tokens are Magpie
  gateway behavior, not Runtime state handling.
- *Real defects fixed below*.

### Fixes from the first run

| Finding | Fix | Regression test |
|---|---|---|
| No service index; new users guess 30+ URLs | `GET /` returns service info, capabilities and the agent-chat entry point (`src/http/create-app.ts`) | `tests/http-api.test.ts` |
| `{"prompt": 123}` accepted as `"123"` (AJV `coerceTypes`) | route `preValidation` rejects non-string prompt with 400 | `tests/task-api.test.ts` |
| Unknown model accepted with 202, failed later | `POST /v1/tasks` checks an explicitly requested model against the live catalog and returns 400 when it is absent; a transient catalog outage does not block submission | `tests/task-api.test.ts` |

### Second blind run (after fixes)

A fresh agent given only the fixed base URL used `GET /`, found
`/v1/agent-chat/conversations`, completed multi-turn memory (42 remembered),
an open-ended plan, and got clean 400s for an unknown model and a numeric
prompt. Overall verdict: **usable as a basic conversational assistant.**

Remaining observations are design properties, not defects: message submission
is asynchronous (poll the conversation for the terminal `replied` state), and
the model is bound at conversation/Agent creation rather than per message.

## Reproducing

Both blind agents are ordinary coding agents with shell access; the only input
is the base URL and the task list above. The important discipline is to **not**
coach them toward the agent-chat surface — if the service index works, they
find it themselves.
