# Conchbase

**A headless-capable runtime for personal AI agents.**

[![CI](https://img.shields.io/github/actions/workflow/status/2648782102/conchbase/ci.yml?branch=main&label=CI)](https://github.com/2648782102/conchbase/actions/workflows/ci.yml) [![MIT License](https://img.shields.io/github/license/2648782102/conchbase)](LICENSE) [![Node.js 24+](https://img.shields.io/badge/Node.js-24%2B-43853d)](https://nodejs.org/)

Conchbase owns agent execution: task lifecycle, model calls, cancellation, explicit retry, ordered events, and persisted state. It works from the CLI without a graphical interface. Pagurus and other clients connect through the same versioned API.

## Current status

Phase 1 runs a real streaming model turn through a local [Magpie](https://usemagpie.ai/docs/integrate) gateway. A task's state, answer-text progress, final output, error, and events are stored in a local SQLite database. CLI and Pagurus can create, inspect, cancel, and retry tasks. A process restart marks unfinished tasks as `interrupted`; explicit retry creates a new attempt and preserves history. The runtime does not silently continue an in-flight model call.

The phase-1 SQLite database has one process owner at a time. A second CLI or service owner fails fast instead of interrupting the live runtime's tasks. `conchbase models` reads Magpie directly and does not open the database; other task-state CLI commands must not run while `conchbase serve` is active. Use the Runtime API to inspect tasks concurrently. This is a development boundary, not production multi-process support. See [ADR 0011](docs/decisions/0011-phase-one-database-instance-ownership.md).

An internal, fixture-only tool capability kernel records exact approvals, per-attempt idempotency, and deterministic audits for development tests; it is not a public tool route and cannot run real host tools. Conchbase `0.4.0` also implements a versioned configuration document API with validation, immutable revision history, apply, and rollback. Its references are opaque data: they do not install Skills/MCP/plugins, resolve secrets, grant tools, or define an agent topology. Model-driven tool execution, capability lifecycle, portable profile files, production approvals, public tool routes, SSE transport, reasoning display, composition management, authentication, and remote access are planned work. The single-turn phase-1 loop is not a hardcoded agent topology; user-defined composition remains topology-neutral product intent. See [ADR 0005](docs/decisions/0005-user-defined-agent-topology-proposal.md), [ADR 0010](docs/decisions/0010-first-real-model-slice.md), [ADR 0012](docs/decisions/0012-streaming-output-progress.md), [ADR 0013](docs/decisions/0013-bounded-tool-capability-kernel.md), and [ADR 0014](docs/decisions/0014-versioned-configuration-api.md).

Deterministic repository guardrail tests keep the accepted phase-1 contracts and AI-first boundaries explicit. CI uses fake provider responses and temporary databases; it does not call a real model.

## Requirements

Node.js 24+ and a running local Magpie gateway for live model calls. Configure model providers and credentials in Magpie itself; Conchbase does not store them.

```sh
npm ci
npm run dev
```

The service listens on `127.0.0.1:4318` and allows loopback binding only. Check it with:

```sh
curl http://127.0.0.1:4318/v1/health
```

## Choose and run a model

```sh
export CONCHBASE_MAGPIE_APP_KEY=magpie-conchbase
npm run cli -- models
export CONCHBASE_MODEL='provider/model-id'
npm run cli -- run 'Reply with exactly: ok'
```

`CONCHBASE_MAGPIE_APP_KEY` is optional and only names Conchbase in Magpie's usage record; it is not a provider credential. `CONCHBASE_MODEL` must be an id from the user's Magpie catalog. `CONCHBASE_MAGPIE_URL` defaults to `http://127.0.0.1:3425`; `CONCHBASE_DB` defaults to `.conchbase/runtime.sqlite` and is git-ignored.

The HTTP API accepts the same operation:

```sh
curl -X POST http://127.0.0.1:4318/v1/tasks \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Reply with exactly: ok","model":"provider/model-id"}'
```

See [the API guide](docs/API.md) and [OpenAPI contract](docs/openapi.yaml) for task, event, cancel, retry, and model-catalog routes.

## Architecture

- Conchbase owns task state and permissions; CLI, Pagurus, and third-party interfaces are clients.
- Magpie is a replaceable local provider behind a narrow adapter. Its response is untrusted data.
- Tasks and ordered events commit atomically through a private `TaskStore`; a UI never reads the database.
- Bounded answer-text chunks become durable `task.output_delta` events and a `partialOutput` snapshot; final output remains authoritative.
- Model discovery is database-free; one process owns the task database during runtime execution.
- One content-addressed configuration revision is pinned per task attempt.
- A Skill supplies instructions, never tool permissions; model-requested tools are rejected in phase 1.

See [architecture](docs/ARCHITECTURE.md), [technology baseline](docs/TECH_STACK.md), [roadmap](docs/ROADMAP.md), and [validation plan](docs/VALIDATION_PLAN.md). The companion console is [Pagurus](https://github.com/2648782102/pagurus). Chinese: [README.zh-CN.md](README.zh-CN.md).

## AI-first development

This project is developed primarily by AI coding agents. Architecture, documentation, and validation optimize for fast context loading, bounded changes, and deterministic verification; future human handoff is not a product requirement. Start with [`AGENTS.md`](AGENTS.md), then read the [AI handoff](docs/AI_HANDOFF.md), [ADR 0010](docs/decisions/0010-first-real-model-slice.md), [ADR 0011](docs/decisions/0011-phase-one-database-instance-ownership.md), [ADR 0012](docs/decisions/0012-streaming-output-progress.md), [ADR 0013](docs/decisions/0013-bounded-tool-capability-kernel.md), [ADR 0014](docs/decisions/0014-versioned-configuration-api.md), [development guide](docs/AI_DEVELOPMENT.md), and [task queue](docs/AI_TASK_QUEUE.md).

Run `npm run check`, `npm test`, and `npm run build` after code changes.

## License

MIT. See [LICENSE](LICENSE).
