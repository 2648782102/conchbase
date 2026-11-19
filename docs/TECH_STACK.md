# Technology baseline

- Runtime: TypeScript on Node.js 24+.
- HTTP: Fastify with versioned JSON routes.
- Persistence: Node's built-in SQLite driver behind Runtime-owned stores.
- Model transport: narrow provider adapters; current compatibility path is a
  local OpenAI-compatible Magpie gateway.
- Client: Pagurus uses React, TypeScript, and Vite in its own repository.
- Streaming: durable event IDs plus Agent Chat SSE projection; polling remains
  a fallback where appropriate.
- Validation: Node test runner, Vitest in Pagurus, temporary local fixtures,
  fake providers, and paired loopback HTTP tests.

## Deliberate future work

Provider portability, storage hardening, backup/restore, packaging, remote
pairing, external integrations, and stronger tool isolation are planned in
[`PROJECT_PLAN.md`](PROJECT_PLAN.md). Do not add a dependency merely because an
enterprise deployment might eventually need it.
