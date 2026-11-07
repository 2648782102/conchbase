# Validation plan

This document records current automated coverage and the next validation layers needed as runtime capabilities arrive.

## Current automated coverage

- Startup configuration accepts only documented loopback hosts/ports and Magpie gateway URLs. A malformed app key is rejected before any request.
- Provider tests use a fake `fetch` to check the Chat Completions request shape, a final answer, tool-call rejection, empty content, HTTP errors, non-loopback URLs, and later-turn rejection.
- Task-service tests use temporary SQLite databases and fake `fetch` to cover durable completion, pinned configuration revision, event IDs/cursors, restart interruption, and explicit retry with a new attempt.
- Model-catalog tests use fake `fetch` to check request shape, valid entries, malformed payloads, and upstream errors without opening a database. Task-store tests assert that a second simultaneous owner fails with `DatabaseInstanceError` and that the database reopens after the first owner closes.
- Fastify injection tests cover read-only status responses, task creation validation, task reads, event replay and unknown cursors, retry, and model-catalog error mapping.
- Internal deterministic tests cover task transitions, cancellation, configuration revisions, event replay, policy denial/approval, and provider-independent fake-model terminal paths.
- Dependency-free repository guardrails check AI-first entry documents, ADR statuses, the accepted phase-1 OpenAPI path set, loopback-only configuration, source boundaries, and dependency boundaries. Synthetic violation fixtures prove the checks reject representative boundary breaks.
- GitHub Actions runs `npm run check`, `npm test`, and `npm run build`.

CI makes no public-network call and uses no real credential or user data. Manual live validation uses the user's already configured Magpie gateway and a selected model id.

## Validation layers still required

1. **Provider conformance:** streaming, structured tool calls, cancellation at transport level, token/context limits, and error classification for each future provider.
2. **Persistence hardening:** supported OS, CPU architecture, and Node-version matrix; migrations; WAL crash recovery under representative crash fixtures; an accepted multi-process writer protocol; retention; and normalized driver errors.
3. **Tools and security:** fake MCP server, side-effect idempotency, approval state, secrets absent from events/logs, untrusted tool output, and explicit grants.
4. **Composition:** one single-node and at least two distinct multi-node user-authored fixtures with no canonical layer count, role name, hierarchy, or coordination pattern.
5. **Client/resilience:** SSE or polling reconnection with cursor semantics, malformed payloads, and live loopback bind assertions.
6. **Access control:** authenticated pairing before any non-loopback bind; desktop packaging checks when that scope is accepted.

## Critical scenarios

- A phase-1 task completes with a real model and its output is persisted with ordered events.
- A denied or model-requested tool never executes in phase 1.
- A restart leaves no task stuck in `running`; events remain replayable.
- Retry starts a new attempt and never silently repeats a lost provider call.
- A task keeps its pinned configuration revision across attempts.
- Event replay does not duplicate or silently skip events.
- Invalid request bodies fail before task creation.
- Non-loopback bind attempts remain rejected until authentication is implemented.
