# Validation plan

This document records current automated coverage and the next validation layers needed as runtime capabilities arrive.

## Current automated coverage

- Startup configuration accepts only documented loopback hosts/ports and Magpie gateway URLs. A malformed app key is rejected before any request.
- Provider tests use a fake `fetch` to check the Chat Completions request shape, a final answer, one transient tool-call observation, unsupported tool-call rejection, empty content, HTTP errors, non-loopback URLs, and later-turn rejection.
- Streaming provider tests use fake SSE responses to check answer-text deltas, ignored reasoning text, one whole message-shaped tool-call observation, streaming tool-call delta rejection, mixed-response rejection, malformed/truncated frames, chunk/output limits, HTTP errors, and cancellation.
- Task-service tests use temporary SQLite databases and fake `fetch` to cover durable v1 completion, pinned configuration revision, event IDs/cursors, restart interruption, and explicit retry with a new attempt.
- Streaming task-service tests cover `partialOutput` while active, ordered `task.output_delta` events, cleared partial output on terminal states and retry, and cancellation history.
- Model-catalog tests use fake `fetch` to check request shape, valid entries, malformed payloads, and upstream errors without opening a database. Task-store tests assert that a second simultaneous owner fails with `DatabaseInstanceError` and that the database reopens after the first owner closes.
- Fastify injection tests cover read-only status responses, task creation validation, task reads, event replay and unknown cursors, retry, and model-catalog error mapping.
- Internal deterministic tests cover task transitions, cancellation, configuration revisions, event replay, policy denial/approval, and provider-independent fake-model terminal paths.
- Internal tool-capability tests cover registry validation, execute-once replay, exact versioned approvals, rejection and invalid-request audit events without secrets or raw arguments, distinct keys per attempt, and normalized executor failures that never invoke a fixture twice.
- Internal composition identity tests cover a single node, a chain, a fan-out/fan-in graph, multiple entry nodes, stable canonical `cmp_` identity, duplicate IDs, duplicate links, unknown endpoints, wrong entry sets, disconnected components, cycles, unknown fields, and credential-like values. No fixture asserts canonical roles, layers, or coordination names.
- Versioned configuration tests cover v1 stability, v1/v2 canonicalization, v2 composition validation, required sections, unaccepted sources, absolute URL labels, secret-like/unknown/duplicate-value rejection, durable mixed-version bootstrap/history/no-op/rollback across restarts, the five HTTP routes, exact error codes, task revision pinning after apply, and the unavailable-service state.
- Composition execution tests cover a single node, a chain, a fan-out/fan-in graph, and multiple entry nodes; event order, node identity, pinned `cmp_` id, deterministic output, no model-provider call, retry from the original pinned v2 revision, and cancellation propagation without later node completion.
- Public tool ledger tests cover normalized tool-call validation, digest stability, v2-only task context, exact eligible task states, declared composition nodes, durable request and decision events, exact idempotent replay without extra events, conflicting decisions, digest-only reasons, and no execution events or provider calls. HTTP tests cover the three `0.6.0` ledger routes, status codes, validation errors, and unavailable-service behavior.
- Pure provider tool-call parser tests cover one valid non-streaming function call, stable `arg_` identity, final-answer non-observation, multiple choices, mixed answer text, multiple or unsupported calls, malformed/oversized/secret-like/nested arguments, unknown fields, invalid tool names, and streaming delta shapes. They assert that the observation has no provider envelope, task/ledger identity, or execution vocabulary.
- Provider observation route tests cover a valid transient response, no-observation response, bounded validation errors, no durable event, no tool request row, no task-state change, and no execution vocabulary. Task-service tests cover a v1 observation becoming `failed` without ledger creation or execution.
- Dependency-free repository guardrails check AI-first entry documents, accepted ADR statuses, the exact `0.7.0` OpenAPI path set and version, loopback-only configuration, source boundaries, and dependency boundaries. Synthetic violation fixtures prove the checks reject representative boundary breaks.
- Repository guardrails also check the `0.7.0` seventeen-route contract, the public event type enum, ADR 0017–0019 statuses, parser wiring boundaries, no auto-ledger assertions, and that the public ledger never imports the internal kernel or exposes execution vocabulary.
- GitHub Actions runs `npm run check`, `npm test`, and `npm run build`.

CI makes no public-network call and uses no real credential or user data. Manual live validation uses the user's already configured Magpie gateway and a selected model id; deterministic composition tests use no provider.

## Validation layers still required

1. **Provider conformance:** streaming across provider transports including tool-call deltas, cancellation at transport level, token/context limits, and error classification for each future provider.
2. **Persistence hardening:** supported OS, CPU architecture, and Node-version matrix; migrations; WAL crash recovery under representative crash fixtures; an accepted multi-process writer protocol; retention; and normalized driver errors.
3. **Model-driven composition:** per-node provider calls, context passing, delegation, concurrency, scheduling, and cancellation across active nodes after accepted contracts.
4. **Tools and security:** streaming tool-call accumulation, public execution contract, durable execution results, crash-safe side effects, real executor isolation, fake MCP server, secret resolution, install/enable/grant isolation, secrets absent from events/logs, untrusted tool output, and explicit grants.
5. **Client/resilience:** SSE or polling reconnection with cursor semantics, malformed payloads, and live loopback bind assertions.
6. **Access control:** authenticated pairing before any non-loopback bind; desktop packaging checks when that scope is accepted.

## Critical scenarios

- A v1 task completes with a real model and its output is persisted with ordered events.
- A v2 task completes a bounded deterministic composition with ordered node events and no model or tool call.
- A denied or model-requested tool never executes in either current task mode.
- A restart leaves no task stuck in `running`; events remain replayable.
- Retry starts a new attempt and never silently repeats a lost provider call.
- A task keeps its pinned configuration revision across attempts.
- Applying or rolling back a revision, including a v1/v2 change, changes only subsequently created tasks and preserves immutable history.
- Event replay does not duplicate or silently skip events.
- Cancellation stops later composition nodes and records explicit node/composition cancellation.
- Invalid request bodies fail before task creation.
- Non-loopback bind attempts remain rejected until authentication is implemented.
