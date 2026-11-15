# Decision 0087: Agent scenario testing for execution boundaries

Status: **accepted and implemented**

Date: 2026-11-16 (Asia/Shanghai).

## Context

The suite had 414 passing tests, but agent behaviour was tested one property at a time: a loop continues after a tool result, a cap rejects an oversized batch, a path escape is refused. Each was true in isolation, and none of them answered the question a user actually cares about — when the agent is given a task, does the trace and the artefact match what it claims?

An agent has no single return value. It decides, calls tools, observes, retries, and eventually asserts something. Unit tests can prove the wiring; they cannot prove that the tool result reached the model's context, that a claimed file exists with the claimed content, or that the agent stopped rather than spun.

## Decision

1. **Scenarios script the model, run the real runtime.** `tests/support/agent-scenario.ts` supplies ordered scripted turns over an OpenAI-compatible stream while the real `TaskService`, real tool providers, and a real temporary workspace execute. Nothing in the runtime under test is mocked.
2. **Assertions target three surfaces.** The workspace (what actually exists), the request trace (what the model was shown), and durable events (what the runtime recorded). A test that only inspects the final string would pass on a fabrication.
3. **Scenarios are Agent tasks, not bare tasks.** An earlier version used `createTask` and silently gave the model no tools at all; tools and Skills reach a model only through the pinned Agent revision's grants. The harness now creates an Agent and grants exactly the tools it registers, which also makes the capability boundary the subject of the test.
4. **Negative behaviour is explicit.** "The agent answered without reading" is a recorded scenario, not an untested gap: the test asserts the file content never entered context and that no tool execution event exists. The runtime cannot detect a lie, but the suite keeps the absence of evidence visible.
5. **Escape and failure are asserted as recorded events.** A traversal must appear as `agent_loop.tool_failed` with `path_escapes_root` and must never appear as `tool_executed`; host content must never reach a request body.
6. **The matrix is documented with its gaps.** `docs/AGENT_TEST_MATRIX.md` lists what is covered and, just as importantly, what is not: parallel tool calls, real-model judgement quality, cross-restart resumption, and approval trajectories, each with where it is covered instead.

## Options

### A. Keep adding single-property unit tests

Consequences: cheap, and they do catch regressions in one branch, but they never compose into "did this task actually get done". Rejected as the only approach.

### B. Run a real model in CI

Consequences: non-deterministic, credential-dependent, slow, and it tests the model's mood rather than the runtime's correctness. Rejected for CI; a manual probe (`scripts/probe-agent-chat.mjs`) remains the way to observe real-model behaviour.

### C. Record and replay real model transcripts

Consequences: realistic, but transcripts go stale as prompts evolve and they encode one model's quirks as the expected contract. Rejected for now.

### D. Scripted model plus real runtime, asserted on trace and artefact

Consequences: deterministic, fast (16 scenarios in about 0.4s), and directly about the properties users care about. Accepted.

## Validation

- 16 scenarios in `tests/agent-scenario.test.ts`: evidence-before-assertion, real writes, capability minimisation, unread-claim, path and write escapes, iteration budget, per-turn cap, tool failure propagation, single-turn answer, durable per-call records, nested paths, multi-step state carry, self-correction after failure, paged large reads, sequential writes.
- Failure injection: removing the lexical escape guard made the traversal scenario fail; disabling the per-turn cap made the cap scenario fail. Both sources were restored and verified. A scenario suite that cannot fail is not evidence.

## Consequences

Agent behaviour is now tested at the level of tasks rather than functions, and the suite fails when a boundary erodes. The remaining honest gap is real-model quality, which is deliberately manual. Every new execution boundary is expected to add a scenario and a matrix row.
