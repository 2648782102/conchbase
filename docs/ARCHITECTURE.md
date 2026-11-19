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
