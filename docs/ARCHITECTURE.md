# Conchbase architecture

Conchbase is the execution authority for a personal Agent. Clients submit
intent and display published state; they do not open the database or decide
permissions.

## Main flow

```text
client message
  -> HTTP/CLI boundary
  -> task or Boss conversation service
  -> bounded model/provider adapter
  -> Runtime-owned tool policy and approval
  -> SQLite state + ordered events
  -> client polling/SSE projection
```

## Ownership

- `src/runtime/` owns domain state, Agent loop, organization, tools, stores,
  providers, recovery, and event semantics.
- `src/http/` owns Fastify setup, authentication, request validation, route
  registration, and response envelopes.
- `src/config/` owns environment parsing and startup validation.
- `src/runtime/*-contract.ts` owns public/domain shapes near their consumers.
- `docs/openapi.yaml` documents the public HTTP surface.

## State and recovery

SQLite is the current local store. Tasks, attempts, messages, revisions, work,
and events must be committed through Runtime-owned stores. Model output and
tool output are untrusted and bounded. Restart, cancellation, retry, timeout,
approval, and duplicate requests are explicit states, not hidden exceptions.

The current runtime has one database owner. Treat multi-process operation,
remote deployment, and long-term backup as future hardening work described in
[`PROJECT_PLAN.md`](PROJECT_PLAN.md).

## Safety boundaries

Provider adapters hide credentials and wire formats. Tools receive only the
capabilities granted to the pinned Agent revision. Approval is Runtime state,
not a client-side permission shortcut. Plaintext secrets never enter prompts,
events, logs, errors, client responses, or generic resolvers. Filesystem and
subprocess operations are bounded by workspace, argument, size, and timeout
rules.

## Paired client

Pagurus consumes published API responses through typed validators. It may show
Runtime state and submit explicit user decisions, but it must not reproduce
Runtime state machines or invent routes. The CLI is another client and should
move toward the same public read paths as the console.

For subsystem details, read the source and focused tests rather than a giant
global design document.

## State machines

Each durable resource has one small table. Transitions outside the table are
bugs; `tests/task-state-machine.test.ts` fails when code and table diverge.

### Task

| From | Allowed to |
|---|---|
| `queued` | `running`, `cancelling`, `failed`, `interrupted` |
| `running` | `waiting_approval`, `cancelling`, `succeeded`, `failed`, `interrupted` |
| `waiting_approval` | `running`, `cancelling`, `failed`, `interrupted` |
| `cancelling` | `cancelled`, `interrupted` |
| `succeeded` / `failed` / `cancelled` | nothing (terminal) |
| `interrupted` | `running` only (checkpoint resume) |

Terminal: `succeeded`, `failed`, `cancelled`, `interrupted`. `interrupted` may
resume once to `running` when a loop checkpoint exists; it never jumps straight
to success or failure.

A `queued` task that has never run is not interrupted on restart: it is
re-admitted, because the caller was already told the Runtime owns the work and
nothing retries an interrupted task.

A task that was `running` without a checkpoint stays `interrupted` on restart,
even though it had only issued a model request. The crash window cannot prove
whether a tool call already ran, and `writeAlreadyApplied` only knows about
recorded executions — replaying could duplicate a write. Recovery is therefore
explicit: the task reports `interrupted`, and the existing retry endpoint starts
a fresh attempt.

### Work item

| From | Allowed to |
|---|---|
| `open` | `running`, `cancelled` |
| `running` | `paused` (cooperative yield), `completed`, `cancelled` |
| `paused` | `running` (re-admission), `cancelled` |
| `completed` / `cancelled` | nothing |

### Assignment

`planned → running → succeeded | failed`; `running → interrupted` on restart;
`interrupted → running` on recovery. No assignment outlives its work item.

### Agent Chat message

User messages are `published`. The assistant message moves through
`thinking → (streaming) → organizing | waiting_approval → replied | failed |
cancelled | unavailable`. `waiting_approval` is a human phase and carries the
pending task id; it returns to the model phase after a decision.

### Rule of thumb

A client never invents a transition. If a UI needs a new state, it is a Runtime
contract change with tests, not a client-side flag.

## Admission

Execution is bounded by `CONCHBASE_MAX_CONCURRENT_TASKS` (default 4). A task
over the limit waits as `queued` with its controller still attached, so it can
be cancelled and a shutdown still aborts it. This matters most at restart, when
every queued task is re-admitted at once: without a bound, a burst opens one
completion stream per task. Admission is per Runtime process, not a durable
state, and never changes the task state machine.

## Policy kernel

`src/kernel/` answers "may this action run?" and "may this process start?".
It holds no state, performs no IO, and imports nothing from `src/runtime`, so
the dependency direction is `http → runtime → kernel` and never the reverse.

### Permission levels

One dimension, four values. A level changes *policy*; it never changes a
boundary.

| Level | Approval | Grant list | Boundary, secret, quotas |
|---|---|---|---|
| `strict` | every tool, including reads | enforced | always |
| `standard` (default) | writes and external calls | enforced | always |
| `trusted` | none | enforced | always |
| `unbounded` | none | waived | always |

`CONCHBASE_PERMISSION_LEVEL` selects the level at startup and is never read from
a task, Agent revision, model output, or request. `CONCHBASE_EXECUTION_MODE`
still works: `restricted` → `standard`, `unrestricted` → `trusted`. Only those
two levels are selectable today; `strict` and `unbounded` land with the kernel
rollout so a configuration value can never promise behaviour that does not
exist yet.

`decidePolicy` resolves in a fixed order, and the order is the contract:
boundary → grants → approval. Reversing it would let a level waive a boundary
it must not waive. An unknown side-effect class is treated as `external`, so a
typo can never downgrade a tool to read-only.

### Process specs

`validateProcessSpec` is the single rule for spawning a child: absolute command,
`cwd` inside the workspace, an environment allowlist, bounded arguments, and a
bounded timeout. It validates; it does not spawn. Modules that already spawn
(the plugin subprocess, git tools, isolated execution) pass through it, so a
new spawn path inherits the rules instead of re-deriving them.

## Side effects

A consequential tool records its intent in `side_effects` *before* it runs, and
marks it `committed` only after it returns. The key is
`task:attempt:tool:argumentsDigest`, so:

- a committed effect is never repeated within the same attempt;
- an `intent` left behind by a crash becomes `unknown` — the Runtime cannot
  prove whether the effect landed, so it refuses to run the call again and
  fails the task with a readable reason;
- a new attempt may legitimately perform the same effect again.

This governs both ways into a tool: the normal loop and the approval-resume
path. The resume path used to call the tool directly, so approving after a
crashed write wrote the file a second time while the task reported success.

`unknown` is a deliberate dead end rather than a retry: recovery is the
explicit `retry` endpoint, which starts a fresh attempt with its own key.

External tools (MCP, plugins) cannot be made idempotent by the Runtime, so the
contract is narrower but still strict: a tool declared `external` is never
assumed safe. It pauses for approval in restricted mode, runs at most once per
attempt, and is recorded like any other effect. MCP reports no trustworthy
side-effect class, so a tool discovered from `tools/list` without a declaration
defaults to `external`; an operator who knows a server is read-only opts in
with `discoverySideEffect: "read"`. Plugin manifests must declare a class —
there is no default.

## Operating model: one process per database

Conchbase is a local, single-process runtime. One process owns one SQLite file
exclusively; a second process opening the same file fails fast with a clear
message instead of corrupting state or silently interleaving writes.

What this means day to day:

- run one `conchbase serve` per database file (or per worktree, which gets its
  own port and database);
- CLI commands that open the database (`tasks`, `task`, `events`, `backup`)
  cannot run concurrently with a live `serve` on the same file — use the HTTP
  API, or a different `CONCHBASE_DB`;
- `conchbase diagnose` reports the port state so a second start is obvious.

Multi-process operation is intentionally not a supported feature yet. It would
need a real lease, cross-process event bus, and conflict policy — a separate
design, not a toggle.

## Packaging choice (P6.1)

The supported distribution target is the **documented local web process**: one
`conchbase` binary/CLI plus `npm run dev` for the Pagurus console. A desktop
wrapper (Electron/Tauri) is deliberately not built: it would add a second
runtime, a large dependency, and a duplicate of the web console without making
the assistant more reliable.

Lifecycle verbs on top of that choice:

| Command | Meaning |
|---|---|
| `conchbase serve` | foreground Runtime, the default |
| `conchbase start` | detached Runtime with `runtime.pid` + `runtime.log` beside the database |
| `conchbase status` | is something healthy answering on the configured port |
| `conchbase logs [n]` | last n lines of the background log |
| `conchbase stop` | SIGTERM, then SIGKILL after the timeout; clears the pid file |

One pid file per database. Because the database is single-owner, `start` refuses
when a live pid already holds that database — the same rule as a foreground
`serve`.
