# Validation plan

This document records current automated coverage and the next validation layers needed as runtime capabilities arrive.

## Current automated coverage

- Startup configuration accepts only documented loopback hosts and decimal ports in range.
- Fastify inject checks the exact response bodies for the implemented read-only status routes. A dependency-free test reads `docs/openapi.yaml` as the source of truth and checks the documented route/schema fields and exact response fixtures.
- Internal deterministic modules cover legal task transitions, terminal rejection, cancellation, configuration revision pinning and history, stable event IDs, replay without duplication, denied/unapproved/revoked tool decisions, and provider-independent fake-model success, failure, and cancellation paths. Event/log-shaped fixtures assert that fake secret markers are not serialized.
- GitHub Actions runs `npm run check`, `npm test`, and `npm run build`.

This is a scaffold-level baseline plus internal domain invariants. It does not validate a live agent loop, user-defined composition, persistence, an exposed task API, or authentication because those features do not exist yet.

## Required validation layers as features arrive

1. **Unit:** task state transitions, policy decisions, config parsing/migration, event serialization, and cancellation. The first four areas now have deterministic internal tests; config migration and wire serialization remain future work.
2. **API contract:** the current read-only fixtures are checked against `docs/openapi.yaml`; generated validation, error responses, writable routes, and loopback binding assertions remain future work.
3. **Integration:** a deterministic internal fake model exists as an acceptance fixture; a fake MCP server, durable integration, no-real-key provider conformance, and user-defined composition fixtures remain future work.
4. **Security:** denied tools never execute; secrets do not enter events/logs; untrusted tool output is treated as data; external binding stays disabled without authentication.
5. **Recovery:** clients can resume events after reconnecting; interrupted tasks reach an explicit terminal or recoverable state.

## Initial critical scenarios

- A read-only request succeeds while a side-effecting tool is denied by policy.
- A tool requiring approval does not execute before approval.
- Cancellation stops the active model/tool operation and is reflected in task state.
- A task keeps its starting configuration revision after a newer revision is applied.
- A single-agent input and distinct multi-role inputs validate without a hardcoded layer count, role name, hierarchy, or coordination pattern.
- A composition input cannot grant tools, bypass policy/approval, or change its pinned configuration revision.
- Event replay does not duplicate or silently skip events.
- Invalid request bodies fail before reaching task execution.
- Non-loopback bind attempts are rejected until authentication is implemented.
