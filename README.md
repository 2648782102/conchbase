# Conchbase

**A headless-capable runtime for personal AI agents.**

[![CI](https://img.shields.io/github/actions/workflow/status/2648782102/conchbase/ci.yml?branch=main&label=CI)](https://github.com/2648782102/conchbase/actions/workflows/ci.yml) [![MIT License](https://img.shields.io/github/license/2648782102/conchbase)](LICENSE) [![Node.js 24+](https://img.shields.io/badge/Node.js-24%2B-43853d)](https://nodejs.org/)

Conchbase owns agent execution: task lifecycle, model calls, cancellation, explicit retry, ordered events, and persisted state. The product direction is for Conchbase to own Agent identities and revisions, managed through its versioned API by Pagurus and other clients; that Agent collection is planned work, while Conchbase remains the execution and permission authority.

The current runtime does not yet implement an Agent collection. Its versioned configuration is one runtime-wide policy/capability revision, and its task model is selected independently; the v2 composition executor makes no model call. The next roadmap milestone must add stable Agent identities, per-Agent revisions, task binding, additive migrations, and a multi-Agent client flow without changing legacy task/configuration behavior.

## Current status

A `schemaVersion: 1` task currently runs one real streaming model turn through Conchbase's Magpie compatibility adapter, which uses a local [Magpie](https://usemagpie.ai/docs/integrate) gateway. Magpie is the supported compatibility path today; it is not the product's only intended provider or the definition of future Agent model references. A `schemaVersion: 2` task runs a bounded deterministic composition with node-level events and no model or tool call. A task's state, progress, final output, error, and events are stored in a local SQLite database. CLI and Pagurus can create, inspect, cancel, and retry tasks. A process restart marks unfinished tasks as `interrupted`; explicit retry creates a new attempt and preserves history. The runtime does not silently continue an in-flight model call or composition.

The phase-1 SQLite database has one process owner at a time. A second CLI or service owner fails fast instead of interrupting the live runtime's tasks. `conchbase models` currently reads the Magpie compatibility catalog directly and does not open the database; the planned provider-neutral discovery contract may expose a different unified catalog without changing Agent identity. Other task-state CLI commands must not run while `conchbase serve` is active. Use the Runtime API to inspect tasks concurrently. This is a development boundary, not production multi-process support. See [ADR 0011](docs/decisions/0011-phase-one-database-instance-ownership.md).

An internal, fixture-only tool capability kernel records exact approvals, per-attempt idempotency, and deterministic audits for development tests; it is not a public tool route and cannot run real host tools. Conchbase `0.7.0` keeps the versioned `schemaVersion: 1` / `schemaVersion: 2` configuration API and the public provider-neutral tool request/approval ledger. A v1 task currently uses one streaming turn through the Magpie compatibility adapter; a v2 task runs a bounded, topology-neutral deterministic composition executor with node-level events and cancellation propagation, without a model call or tool execution. The ledger accepts normalized tool call proposals for eligible v2 task attempts, persists composition-scoped request and decision records plus durable audit events, and never executes a tool or grants a capability. ADR 0019 adds a transient provider observation boundary: one non-streaming function tool call can be normalized by the provider or `POST /v1/provider-observations/tool-calls`, but the live v1 task path fails visibly rather than creating a ledger request or executing a tool. A client must explicitly submit the normalized `toolCall` with task and composition identity through `POST /v1/tool-requests`. Configuration references remain opaque data: they do not install Skills/MCP/plugins, resolve secrets, grant tools, or define a fixed topology. Model-driven node work, delegation, concurrency, streaming tool-call accumulation, model-driven tool execution, public execution routes, real executor isolation, crash-safe side effects, capability lifecycle, portable profile files, production approvals, SSE transport, reasoning display, authentication, and remote access are planned work. Neither current task mode is a hardcoded agent topology; user-defined composition remains topology-neutral. See [ADR 0005](docs/decisions/0005-user-defined-agent-topology-proposal.md), [ADR 0010](docs/decisions/0010-first-real-model-slice.md), [ADR 0012](docs/decisions/0012-streaming-output-progress.md), [ADR 0013](docs/decisions/0013-bounded-tool-capability-kernel.md), [ADR 0014](docs/decisions/0014-versioned-configuration-api.md), [ADR 0015](docs/decisions/0015-composition-identity-kernel.md), [ADR 0016](docs/decisions/0016-composition-execution-and-public-schema.md), [ADR 0017](docs/decisions/0017-public-tool-request-approval-ledger.md), [ADR 0018](docs/decisions/0018-provider-tool-call-parsing-boundary.md), and [ADR 0019](docs/decisions/0019-explicit-provider-tool-call-observation-boundary.md).

Deterministic repository guardrail tests keep the accepted phase-1 contracts and AI-first boundaries explicit. CI uses fake provider responses and temporary databases; it does not call a real model.

## Requirements

Node.js 24+; the current Magpie compatibility adapter also needs a running local Magpie gateway for live model calls. Configure its provider credentials in Magpie; future adapters may own credentials through their own Conchbase-managed boundaries, and secrets must stay outside Agent documents and client responses.

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

These environment variables describe the current Magpie compatibility adapter: `CONCHBASE_MAGPIE_APP_KEY` is optional and only names Conchbase in Magpie's usage record; it is not a provider credential. `CONCHBASE_MODEL` currently selects an id from the Magpie catalog. `CONCHBASE_MAGPIE_URL` defaults to `http://127.0.0.1:3425`; `CONCHBASE_DB` defaults to `.conchbase/runtime.sqlite` and is git-ignored. Future provider-neutral Agent references and discovery must not depend on these Magpie-specific variable names or catalog ids.

The HTTP API accepts the same operation:

```sh
curl -X POST http://127.0.0.1:4318/v1/tasks \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Reply with exactly: ok","model":"provider/model-id"}'
```

See [the API guide](docs/API.md) and [OpenAPI contract](docs/openapi.yaml) for task, event, configuration, model-catalog, and tool request/approval ledger routes.

## Architecture

- Conchbase owns task state and permissions; CLI, Pagurus, and third-party interfaces are clients.
- The current Magpie compatibility adapter sits behind a narrow provider boundary; additional adapters can implement the same provider-neutral domain contract. Provider responses are untrusted data.
- Tasks and ordered events commit atomically through a private `TaskStore`; a UI never reads the database.
- Bounded answer-text chunks become durable `task.output_delta` events and a `partialOutput` snapshot; final output remains authoritative.
- Composition node progress becomes durable composition events with the pinned `cmp_` identity and configuration revision.
- Model discovery is database-free; one process owns the task database during runtime execution.
- One content-addressed configuration revision is pinned per task attempt.
- A v1/v2 versioned configuration union keeps older documents valid while enabling topology-neutral composition data.
- A Skill supplies instructions, never tool permissions; model-requested tools are rejected in phase 1.
- A public tool request/approval decision is durable ledger state, never execution permission. A transient provider observation is untrusted normalization data, never execution permission.

See [architecture](docs/ARCHITECTURE.md), [technology baseline](docs/TECH_STACK.md), [roadmap](docs/ROADMAP.md), and [validation plan](docs/VALIDATION_PLAN.md). The companion console is [Pagurus](https://github.com/2648782102/pagurus). Chinese: [README.zh-CN.md](README.zh-CN.md).

## AI-first development

This project is developed primarily by AI coding agents. Architecture, documentation, and validation optimize for fast context loading, bounded changes, and deterministic verification; future human handoff is not a product requirement. Start with [`AGENTS.md`](AGENTS.md), then read the [AI handoff](docs/AI_HANDOFF.md), [ADR 0010](docs/decisions/0010-first-real-model-slice.md), [ADR 0011](docs/decisions/0011-phase-one-database-instance-ownership.md), [ADR 0012](docs/decisions/0012-streaming-output-progress.md), [ADR 0013](docs/decisions/0013-bounded-tool-capability-kernel.md), [ADR 0014](docs/decisions/0014-versioned-configuration-api.md), [ADR 0015](docs/decisions/0015-composition-identity-kernel.md), [ADR 0016](docs/decisions/0016-composition-execution-and-public-schema.md), [ADR 0017](docs/decisions/0017-public-tool-request-approval-ledger.md), [ADR 0018](docs/decisions/0018-provider-tool-call-parsing-boundary.md), [ADR 0019](docs/decisions/0019-explicit-provider-tool-call-observation-boundary.md), [development guide](docs/AI_DEVELOPMENT.md), and [task queue](docs/AI_TASK_QUEUE.md).

Run `npm run check`, `npm test`, and `npm run build` after code changes.

## License

MIT. See [LICENSE](LICENSE).
