# Boss Agent Continuous Orchestration Design

## Intent

The product is a continuous conversation with one Boss Agent. The user can keep talking, assigning work, changing priorities, and asking for status while background workers continue. The Boss Agent is an orchestrator: it understands intent, creates or reuses roles, delegates work, watches durable results, and reports back. It never blocks the conversation waiting for a worker.

## Goals

- Boss Chat turns settle immediately with a bounded acknowledgement or organization summary.
- Worker execution runs after the Boss turn settles and cannot keep the assistant message in `organizing`.
- Worker completion, failure, attention, and progress are published as separate Boss conversation updates.
- New Boss turns read current organization facts, reports, and project facts before answering or delegating again.
- Role names such as PM are data chosen by the Boss Agent, not a hard-coded management layer.
- User-facing identity is `Boss Agent`; internal id `boss-agent` stays compatible.

## Non-goals

- No generic unrestricted host execution.
- No fixed PM class as the only delegation path.
- No client-owned task state; Runtime remains authoritative.
- No replacement of durable organization events with ad-hoc chat messages.

## Anti-goals

- A Boss reply that says “已安排” and then blocks until workers finish.
- A user message queued behind an `organizing` Boss message while employees are running.
- Treating worker reports as a one-time overwrite of the previous Boss reply.
- Hard-coding a PM hierarchy that the Boss Agent cannot redefine.

## Current State

- `BossModeService.submit` defaults to `waitForTasks=true`; it awaits `collectWorkerOutcomes` and `drainHeldWorkers` before resolving.
- `AgentChatService.postBossMessage` keeps the assistant message in `organizing` until `submit` settles, so a second user turn is queued.
- Worker reports are durable (`organization.report_recorded` + `reportText`), but they are currently folded into one Boss reply.
- `BossMemory` handles runtime/project/agent memory proposals, not worker-specific memory.
- Existing `announceBossNotice` is the seed for asynchronous Boss conversation updates.

## Architecture

### 1. Synchronous Boss Turn

The Boss turn ends after: validate input, parse strict JSON, apply organization actions, and create a bounded acknowledgement. It does not wait for worker tasks. Assistant state becomes terminal immediately.

### 2. Asynchronous Orchestrator

Worker waiting/report collection moves to a Runtime-owned background runner. It observes durable work state, starts admitted workers, records reports, and publishes progress. It must survive restarts by reading organization events and task state rather than relying only on in-memory promises.

### 3. Progress and Report Bus

Worker terminal outcomes produce organization events and report text. A bridge publishes bounded Boss notices for completed, failed, attention, and meaningful progress events. These notices are separate chat messages and never block new user turns.

### 4. Boss Facts on Next Turn

The next Boss model call receives current projects, workers, reports, attention, and bounded project facts/memory. The Boss uses those facts to summarize, reassign, or continue.

### 5. Roles as Data

Every worker has a display name, instructions digest, scope, capabilities, and model reference. PM is only one possible display name/instruction set. The Boss can create, reuse, offboard, or resume any role by organization action; no product layer assumes PM exists.

### 6. Project Facts and Worker Memory

Project facts are durable, bounded, reviewable records attached to a project. Worker reports feed candidate facts; Runtime validates size and secret boundaries. Boss facts inject a bounded index into the next Boss turn.

### 7. Naming

All user-facing strings become `Boss Agent`. The id `boss-agent` remains unchanged for compatibility.

## Delivery Order

1. Decouple Boss chat turn from worker completion.
2. Add async worker completion/attention notices.
3. Add project facts and worker report-to-fact promotion.
4. Make role naming fully data-driven and test PM-optional behavior.
5. Rename user-facing strings and docs to Boss Agent.

## Verification

- A Boss message with a worker action reaches terminal state before the worker completes.
- A second Boss message is accepted while the first worker is still running.
- Worker completion creates a separate Boss notice/report message.
- New Boss turns see latest durable reports and project facts.
- Boss can create arbitrary role names without a PM-specific branch.
- No user-facing `老板 Agent` remains after migration.
- Both repositories pass full check/test/build and are pushed.
