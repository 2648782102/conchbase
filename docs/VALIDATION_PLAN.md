# Validation plan

This plan is for future implementation work; the repository currently has no automated test suite.

## Current CI

GitHub Actions runs `npm run check` and `npm run build`. This catches TypeScript and compilation errors, not runtime behavior or security regressions.

## Required validation layers as features arrive

1. **Unit:** task state transitions, policy decisions, config parsing/migration, event serialization, and cancellation.
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
