# Live agent evaluations

These drive a **real model** through the real HTTP Runtime to answer a question
the deterministic suite cannot: given a task it has not seen, does the agent
produce a correct artefact?

## Running

```sh
npm run eval                      # all tasks, default model
npm run eval -- --task refactor   # one task
npm run eval -- --model deepseek/deepseek-v4-pro
node evals/harness.mjs --keep     # keep the workspace for inspection
```

Requires a running Magpie gateway (`CONCHBASE_MAGPIE_URL`, default
`http://127.0.0.1:3425`). Each run costs real model calls.

## What each run does

1. Starts a Runtime on an ephemeral port with a fresh database and a fresh
   temporary workspace. Nothing touches the developer's checkout or the main
   runtime database.
2. Creates a dedicated Agent with exactly the tools the task declares.
3. Opens a conversation, sends the prompt, and polls until a terminal state.
4. Asserts on the **workspace** and the **trace** — never on the model's wording.
5. Writes a JSON report under `evals/reports/` and exits non-zero if any task
   fails.

## Task contract

A task module exports:

```js
export default {
  id: 'unique-id',
  instructions: 'system instructions for the Agent',
  tools: ['workspace_list', 'workspace_read', 'workspace_write'],
  setup() { return { 'relative/path.txt': 'content' }; },
  prompt: 'what the user asks',
  async assert({ run, read, before }) {
    return { passed: true } | { passed: false, reason: '...' };
  },
};
```

`run` carries state, elapsed time, turn and tool counts, the reply body, and a
workspace snapshot. `read(path)` reads a file from the run workspace after the
task. `before` is the snapshot taken before the prompt.

## Current tasks

| Task | What it proves |
| --- | --- |
| `inventory` | Multi-file discovery, aggregation, and a written artefact whose numbers are only right if every file was read. |
| `refactor` | A real code fix verified by **executing** the result, not by diffing text. |
| `boundary-escape` | Host-file access is refused and never fabricated. |
| `long-chain` | Four dependent steps where one wrong value makes the result wrong. |
| `insufficient-budget` | Under a tight budget the agent stops honestly instead of claiming completion. |
| `context-switch` | A mid-task requirement change supersedes the old artefact. |

## Deliberate limits

- **Not in CI.** These need a live gateway, cost money, and are non-deterministic.
  The deterministic suite (`npm test`) remains the merge gate.
- **One model by default.** Results describe that model. Pass `--model` to
  compare, and read `evals/reports/*.json` rather than treating one pass as a
  general claim.
- **Assertions are behavioural, not aesthetic.** A pass means the artefact is
  correct and the boundary held; it says nothing about how nice the reply reads.
