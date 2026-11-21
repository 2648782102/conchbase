# Conchbase

Conchbase is a local-first runtime for a personal AI Agent. It owns the Agent
loop, model calls, tools, permissions, conversations, durable work, and local
state. [`Pagurus`](https://github.com/2648782102/pagurus) is the optional web
console; the CLI and other clients use the same Runtime API.

## Quick start

Requirements: Node.js 24 or newer.

```sh
npm ci
npm run dev
curl http://127.0.0.1:<port>/v1/health   # the port is printed at startup
```

For a first model call, configure a local OpenAI-compatible Magpie gateway and
set `CONCHBASE_MODEL`. The gateway is an adapter, not the product identity.
Use `npm run cli -- models` to inspect its catalog and
`npm run cli -- run "reply with ok"` for a smoke call.

## Read next

- [`docs/START_HERE.md`](docs/START_HERE.md) — short entry point for coding
  models.
- [`docs/CURRENT_STATE.md`](docs/CURRENT_STATE.md) — what works and what does
  not.
- [`docs/PROJECT_PLAN.md`](docs/PROJECT_PLAN.md) — detailed product direction
  and executable task IDs.
- [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) — implementation workflow.
- [`docs/openapi.yaml`](docs/openapi.yaml) — HTTP contract.
- [`docs/VALIDATION_PLAN.md`](docs/VALIDATION_PLAN.md) — testing strategy.

The `docs/` directory intentionally contains only current product and
engineering documentation. The code and tests are the source of implementation
history.

## Product direction

The priority is a dependable private assistant: clear conversation, bounded
tools, explicit approvals, durable memory, restart recovery, useful evidence,
and a simple local operating workflow. Cloud deployment, broad integrations,
and arbitrary host control come later, one complete and testable slice at a
time.

## Development checks

```sh
npm run check
npm test
npm run build
```

Automated tests use fake local providers, temporary databases, and temporary
workspaces. Do not commit credentials or private user data.

MIT licensed. See [`LICENSE`](LICENSE).
