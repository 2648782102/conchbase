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

## Agent Chat turns run in order

Agent Chat accepts a second message while an earlier reply is still being
written — the composer says so, and the message is accepted immediately. What
it does not do is start a second task alongside the first.

Each task's prompt is built from the transcript as it stands when the task
starts. Two tasks started together would each miss the other's reply and one
question would be flattened into the other's prompt as text. So a turn accepted
while the conversation is busy is **queued**: its message pair is recorded
immediately, the assistant message reports `pending` with a null `taskId`, and
the task is created when the preceding one finishes.

The visible behaviour is unchanged for a reader — the question appears at once,
and the reply arrives when it is ready. What changes is that the later prompt
sees the earlier reply, so the conversation the model is given is the one a
reader believes they are having.

Promotion is driven by task transitions, not by readers. A conversation with a
queue subscribes to them for as long as the queue exists, so a client that never
polls still gets its queued reply; the subscription is released when the queue
empties, which is why it is not taken in the constructor (that would leave one
listener per service instance). Promotion is bounded — one turn per conversation
in flight, a concurrent promotion a no-op — and settles the record first, since
a finished task carries its output before the assistant message has learned it.
The queue is in-memory, so a restart drops it; a turn that had already started
is handled by the normal interruption path.

### Context window

Each turn's prompt carries the most recent eight turns — `CONVERSATION_WINDOW`
in `agent-chat.ts` — trimmed forward to a question so the transcript never opens
on an answer whose question was cut off. The transcript published over the API
is the full history; the window is what a model is given. A conversation longer
than eight turns is therefore answered with its recent context only, and a reply
that does not recall something said much earlier is expected rather than a
fault. The limit is fixed, not configurable.

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

One dimension, three values. A level changes *policy*; it never changes a
boundary.

| Level | Approval | Grant list | Boundary, secret, quotas |
|---|---|---|---|
| `strict` | every tool, including reads | enforced | always |
| `standard` (default) | writes and external calls | enforced | always |
| `trusted` | none | enforced | always |

`CONCHBASE_PERMISSION_LEVEL` selects the level at startup and is never read from
a task, Agent revision, model output, or request. `CONCHBASE_EXECUTION_MODE`
still works: `restricted` → `standard`, `unrestricted` → `trusted`. There is no
level that waives grants: a level answers "how much ceremony surrounds an
allowed action", never "what may this Agent touch".

`decidePolicy` resolves in a fixed order, and the order is the contract:
boundary → grants → approval. Reversing it would let a level waive a boundary
it must not waive. An unknown side-effect class is treated as `external`, so a
typo can never downgrade a tool to read-only.

### Scope

`scopeToolSet` answers the other half of the same question: given what the
Runtime registers and what an Agent revision was granted, which names survive.
It lives here rather than in `capability-grants.ts` so that "may this Agent use
this" and "must a human approve it" have one owner. While they were split, a
change to one could not see the other — which is how `unbounded` came to waive
a grant list `capability-grants.ts` believed was unconditional.

Two properties are structural rather than enforced by convention:

- the output is always a subset of the registered set, so no grant can conjure
  a tool into existence;
- tools and skills are separate namespaces, so a skill grant never authorizes a
  tool that happens to share its name.

`capability-grants.ts` now applies the kernel's answer to a provider; it no
longer holds a copy of the rule.

### Process specs

`validateProcessSpec` is the single rule for spawning a child: absolute command,
`cwd` inside the workspace, an environment allowlist, bounded arguments, and a
bounded timeout. It validates; it does not spawn. Modules that already spawn
(the plugin subprocess, git tools) pass through it, so a new spawn path inherits
the rules instead of re-deriving them. `resolveProgram` turns a bare name such
as `git` into an absolute path once, from an explicitly supplied `PATH`, so a
conventional binary name does not force a caller to hard-code a machine path.

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

### Backups

Snapshots are taken automatically, because a backup the operator must remember
to run is the failure mode that loses data. `CONCHBASE_BACKUP_INTERVAL_MS`
defaults to 24 hours and `0` disables it; `CONCHBASE_BACKUP_KEEP` defaults to 7;
`CONCHBASE_BACKUP_DIR` defaults to `backups/` beside the database.

The snapshot runs on the live connection (`store.backupTo`), which is the only
connection that may open the file — `PRAGMA locking_mode = EXCLUSIVE` means an
external process cannot. Consequences that the implementation respects:

- a failure is recorded in `status()` and never thrown into the task loop;
- runs are serialized, so a slow snapshot cannot queue up behind itself;
- rotation happens in the same operation, so the directory cannot grow without
  bound;
- the timer is `unref`'d, so a pending snapshot never keeps the process alive,
  and shutdown awaits an in-flight one so it cannot be cut in half.

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
