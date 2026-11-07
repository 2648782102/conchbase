# Validation plan

This document records current automated coverage and the next validation layers needed as runtime capabilities arrive.

## Current automated coverage

- Startup configuration accepts only documented loopback hosts and decimal ports in range.
- Fastify inject checks the exact response bodies for the implemented read-only status routes.
- Internal deterministic modules cover legal task transitions, terminal rejection, cancellation, configuration revision pinning and history, stable event IDs, replay without duplication, and denied/unapproved tool execution.
- GitHub Actions runs `npm run check`, `npm test`, and `npm run build`.

This is a scaffold-level baseline plus internal domain invariants. It does not validate a live agent loop, persistence, an exposed task API, or authentication because those features do not exist yet.

## Required validation layers as features arrive

1. **Unit:** task state transitions, policy decisions, config parsing/migration, event serialization, and cancellation. The first four areas now have deterministic internal tests; config migration and wire serialization remain future work.
2. **API contract:** validate live responses against `docs/openapi.yaml`; assert errors and loopback binding.
3. **Integration:** deterministic fake model and fake MCP server; no real API keys and no external network dependency.
4. **Security:** denied tools never execute; secrets do not enter events/logs; untrusted tool output is treated as data; external binding stays disabled without authentication.
5. **Recovery:** clients can resume events after reconnecting; interrupted tasks reach an explicit terminal or recoverable state.

## Initial critical scenarios

- A read-only request succeeds while a side-effecting tool is denied by policy.
- A tool requiring approval does not execute before approval.
- Cancellation stops the active model/tool operation and is reflected in task state.
- A task keeps its starting configuration revision after a newer revision is applied.
- Event replay does not duplicate or silently skip events.
- Invalid request bodies fail before reaching task execution.
- Non-loopback bind attempts are rejected until authentication is implemented.
