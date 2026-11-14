# Conchbase

**A headless-capable runtime for personal AI agents.**

[![CI](https://img.shields.io/github/actions/workflow/status/2648782102/conchbase/ci.yml?branch=main&label=CI)](https://github.com/2648782102/conchbase/actions/workflows/ci.yml) [![MIT License](https://img.shields.io/github/license/2648782102/conchbase)](LICENSE) [![Node.js 24+](https://img.shields.io/badge/Node.js-24%2B-43853d)](https://nodejs.org/)

Conchbase owns Agent execution, identity and revisions, task bindings, model calls, cancellation, explicit retry, ordered events, and persisted state. Pagurus and other clients manage Agents through the versioned Runtime API; Conchbase remains the execution and permission authority.

Conchbase `1.0.0` provides runtime-local Agent profiles with immutable revision history, default selection, duplicate/archive, provider-neutral model references, and Agent-bound tasks. Each Agent task pins its Agent revision, the separate runtime-wide configuration revision, and effective provider/model, then runs one model turn. The global configuration still owns policy/capability references and optional topology; legacy tasks retain their established v1/v2 dispatch, including deterministic v2 composition with no model call.

[ADR 0024](docs/decisions/0024-durable-work-domain-and-public-api.md) is the historical first durable-work slice. [ADR 0025](docs/decisions/0025-local-first-v1-platform.md) closes the final local-first target: exact 47-path `1.0.0` OpenAPI, work contract version 2, authenticated pairing metadata, explicitly enabled authenticated non-loopback binding, durable work control and restart recovery, one local Source, a capability directory, and write-only SecretHandles with process-scoped sealed values and digest-only fixed-adapter use receipts. `docs/openapi.yaml` is `1.0.0` with 47 paths.

## Current status

A `schemaVersion: 1` task currently runs one real streaming model turn through Conchbase's Magpie compatibility adapter, which uses a local [Magpie](https://usemagpie.ai/docs/integrate) gateway. Magpie is the supported compatibility path today; it is not the product's only intended provider or the definition of future Agent model references. A `schemaVersion: 2` task runs a bounded deterministic composition with node-level events and no model or tool call. A task's state, progress, final output, error, and events are stored in a local SQLite database. CLI and Pagurus can create, inspect, cancel, and retry tasks. A process restart marks unfinished tasks as `interrupted`; explicit retry creates a new attempt and preserves history. The runtime does not silently continue an in-flight model call or composition.

The SQLite database has one process owner at a time. A second CLI or service owner fails fast instead of interrupting the live runtime's tasks. `conchbase models` remains a database-free Magpie compatibility command. Agent clients use the provider-neutral `/v1/model-catalog`; the current runtime registers only the `magpie` compatibility adapter. Other task-state CLI commands must not run while `conchbase serve` is active. Use the Runtime API to inspect tasks concurrently. This is a development boundary, not production multi-process support. See [ADR 0011](docs/decisions/0011-phase-one-database-instance-ownership.md).

An internal, fixture-only tool capability kernel records exact approvals, per-attempt idempotency, and deterministic audits for development tests; it is not a public tool route and cannot run real host tools. Conchbase `1.0.0` keeps the versioned `schemaVersion: 1` / `schemaVersion: 2` configuration API and the public provider-neutral tool request/approval ledger. A legacy v1 task uses one streaming turn through the Magpie compatibility adapter; a legacy v2 task runs a bounded, topology-neutral deterministic composition executor with node-level events and cancellation propagation, without a model call or tool execution. Agent tasks bind a selected immutable Agent revision and run one provider/model turn. The ledger accepts normalized tool call proposals for eligible v2 task attempts, persists composition-scoped request and decision records plus durable audit events, and never executes a tool or grants a capability. ADR 0019 adds a transient provider observation boundary: one non-streaming function tool call can be normalized by the provider or `POST /v1/provider-observations/tool-calls`, but the live v1 task path fails visibly rather than creating a ledger request or executing a tool. A client must explicitly submit the normalized `toolCall` with task and composition identity through `POST /v1/tool-requests`. Agent instructions and configuration references never grant tools. Model-driven node work, delegation, concurrency, streaming tool-call accumulation, model-driven tool execution, public execution routes, real executor isolation, crash-safe side effects, capability lifecycle, portable profile files, production approvals, SSE transport, reasoning display, production remote pairing UX, and cloud deployment remain outside the final local-first target. See [ADR 0005](docs/decisions/archive/0005-user-defined-agent-topology-proposal.md), [ADR 0010](docs/decisions/0010-first-real-model-slice.md), [ADR 0012](docs/decisions/0012-streaming-output-progress.md), [ADR 0013](docs/decisions/0013-bounded-tool-capability-kernel.md), [ADR 0014](docs/decisions/0014-versioned-configuration-api.md), [ADR 0015](docs/decisions/0015-composition-identity-kernel.md), [ADR 0016](docs/decisions/0016-composition-execution-and-public-schema.md), [ADR 0017](docs/decisions/0017-public-tool-request-approval-ledger.md), [ADR 0018](docs/decisions/0018-provider-tool-call-parsing-boundary.md), [ADR 0019](docs/decisions/0019-explicit-provider-tool-call-observation-boundary.md), and [ADR 0020](docs/decisions/0020-multi-agent-and-provider-neutral-model-contract.md).

Deterministic repository guardrail tests keep the accepted phase-1 contracts and AI-first boundaries explicit. ADR 0021 adds an opt-in live loopback acceptance test that exercises Pagurus's published clients against the real Runtime and two independent Agents using a deterministic fake Magpie-compatible gateway; it skips only in a standalone Conchbase checkout. CI uses fake provider responses and temporary databases; it does not call a real model. This is deterministic HTTP acceptance, not real-provider, visual/manual UI, remote, or production-storage validation.

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
export CONCHBASE_ORGANIZATION_INTENT_MODEL='model-id-for-structured-organization-intents'
npm run cli -- run 'Reply with exactly: ok'
```

These environment variables describe the current Magpie compatibility adapter: `CONCHBASE_MAGPIE_APP_KEY` is optional and only names Conchbase in Magpie's usage record; it is not a provider credential. `CONCHBASE_MODEL` currently selects an id from the Magpie catalog. `CONCHBASE_MAGPIE_URL` defaults to `http://127.0.0.1:3425`; `CONCHBASE_DB` defaults to `.conchbase/runtime.sqlite` and is git-ignored. Future provider-neutral Agent references and discovery must not depend on these Magpie-specific variable names or catalog ids; the published `GET /v1/model-catalog` and Agent model references already use `{ providerId, modelId }` identities.

`CONCHBASE_ORGANIZATION_INTENT_MODEL` enables the real structured model adapter for the Boss-mode primary conversation. It is optional; without it the Runtime uses the deterministic offline parser. In both modes the model or parser output is untrusted: every proposed organization action is reparsed, validated, and authorized by Conchbase before commit.

The HTTP API accepts the same operation:

```sh
curl -X POST http://127.0.0.1:4318/v1/tasks \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Reply with exactly: ok","model":"provider/model-id"}'
```

See [the API guide](docs/API.md) and [OpenAPI contract](docs/openapi.yaml) for `1.0.0` platform routes, additive `1.1.0` organization routes, additive `1.2.0` controlled-execution routes, additive `1.3.0` isolated execution-run routes, additive `1.4.0` primary-conversation projection routes, and additive `1.5.0` Agent Chat routes. Boss Mode `1.1.0` adds one primary-conversation intent entry; controlled execution `1.2.0` adds explicit grants and approvals; `1.3.0` adds an isolated local child-process executor with durable runs and recovery; `1.4.0` publishes a bounded ordered primary-conversation read model over Runtime facts; `1.5.0` is a separate direct Agent Chat module that reuses configured Agent revisions and the user-configured Magpie OpenAI-compatible protocol endpoint for real model replies. Boss Mode is also exposed inside Agent Chat as a Runtime-owned 老板 Agent adapter, not a second user-editable Agent profile. Agent display names are Chinese by default. See [v1.1.0](docs/RELEASE_NOTES_1.1.0.zh-CN.md), [v1.2.0](docs/RELEASE_NOTES_1.2.0.zh-CN.md), [v1.3.0](docs/RELEASE_NOTES_1.3.0.zh-CN.md), [v1.4.0](docs/RELEASE_NOTES_1.4.0.zh-CN.md), [v1.5.0](docs/RELEASE_NOTES_1.5.0.zh-CN.md), and the [Chinese quick start](docs/QUICK_START.zh-CN.md).

## Architecture

- Conchbase owns task state and permissions; CLI, Pagurus, and third-party interfaces are clients.
- The current Magpie compatibility adapter sits behind a narrow provider boundary; additional adapters can implement the same provider-neutral domain contract. Provider responses are untrusted data.
- Tasks and ordered events commit atomically through a private `TaskStore`; a UI never reads the database.
- Bounded answer-text chunks become durable `task.output_delta` events and a `partialOutput` snapshot; final output remains authoritative.
- Composition node progress becomes durable composition events with the pinned `cmp_` identity and configuration revision.
- Model discovery is database-free; one process owns the task database during runtime execution.
- One content-addressed configuration revision is pinned per task attempt.
- Agent profiles have independent immutable revisions. Each Agent task exposes and pins the selected Agent revision and effective provider/model alongside its runtime configuration revision.
- A v1/v2 versioned configuration union keeps older documents valid while enabling topology-neutral composition data.
- A Skill supplies instructions, never tool permissions; model-requested tools are rejected in phase 1.
- A public tool request/approval decision is durable ledger state, never execution permission. A transient provider observation is untrusted normalization data, never execution permission.

See [architecture](docs/ARCHITECTURE.md), [technology baseline](docs/TECH_STACK.md), [roadmap](docs/ROADMAP.md), [validation plan](docs/VALIDATION_PLAN.md), and the complete [Organization Runtime target](docs/ORGANIZATION_RUNTIME_TARGET.zh-CN.md). The companion console is [Pagurus](https://github.com/2648782102/pagurus). Chinese: [README.zh-CN.md](README.zh-CN.md), [quick start](docs/QUICK_START.zh-CN.md), [target-mode brief](docs/OBJECTIVE_MODE.zh-CN.md), [v1.0.0 release notes](docs/RELEASE_NOTES_1.0.0.zh-CN.md), [v1.1.0 release notes](docs/RELEASE_NOTES_1.1.0.zh-CN.md), [v1.2.0 release notes](docs/RELEASE_NOTES_1.2.0.zh-CN.md), and [v1.3.0 release notes](docs/RELEASE_NOTES_1.3.0.zh-CN.md). The optional [visual overview](docs/VISUAL_OVERVIEW.zh-CN.md) is a human-facing illustration only, not a contract source of truth.

## AI-first development

This project is developed primarily by AI coding agents. Architecture, documentation, and validation optimize for fast context loading, bounded changes, and deterministic verification; future human handoff is not a product requirement. Start with [`AGENTS.md`](AGENTS.md), then follow `docs/PROJECT_STATUS.json`'s `aiEntry.requiredOrder`: the [AI handoff](docs/AI_HANDOFF.md), the machine-readable [project status](docs/PROJECT_STATUS.json), the Chinese [target-mode brief](docs/OBJECTIVE_MODE.zh-CN.md), the [development guide](docs/AI_DEVELOPMENT.md), and [task queue](docs/AI_TASK_QUEUE.md). Read accepted ADRs [0010–0054](docs/decisions/), the [complete Organization Runtime target](docs/ORGANIZATION_RUNTIME_TARGET.zh-CN.md), and the linked architecture/API documents next. ADR 0041 completes the Boss-mode product loop and its dual-repository executable acceptance fixture; ADR 0049 gives the Boss Agent natural conversations while Runtime remains the only organization authority; ADR 0050 separates pure chat from organization writes, adds readable organization facts and real streaming progress, and persists Agent Chat across restart under private `user_version = 5`; ADR 0051 adds model selection from the Magpie catalog to Agent Chat setup.

Before implementing the next product slice, read [ADR 0025](docs/decisions/0025-local-first-v1-platform.md), [ADR 0041](docs/decisions/0041-boss-mode-product-loop.md), [ADR 0042](docs/decisions/0042-controlled-execution-direction.md), [ADR 0043](docs/decisions/0043-controlled-execution-v1.md), [ADR 0044](docs/decisions/0044-isolated-local-execution-v2.md), [ADR 0045](docs/decisions/0045-primary-conversation-projection.md), and [ADR 0046](docs/decisions/0046-agent-chat-module.md). ADR 0025 is the final local-first contract and execution substrate; ADR 0041 completes the Boss-mode organization loop; ADR 0043 implements the controlled-execution v1 boundary; ADR 0044 implements deterministic isolated local execution v2 with durable runs and recovery; ADR 0045 publishes the primary-conversation read model; ADR 0046 adds the separate Agent Chat module. Future durable cross-process chat, provider transcript streaming, external adapters, stable cross-process keys, real Sources, external writes, MCP/Skill/plugin lifecycle, and arbitrary host tool execution require separate accepted implementation contracts.

Run `npm run check`, `npm test`, and `npm run build` after code changes.

> Final local-first target: Conchbase `1.0.0` and ADR 0025 close the exact 47-path platform contract. Write-only SecretHandle values are sealed at rest with a process-scoped AES-256-GCM key, exposed only to one runtime-owned fixed adapter, and never returned, logged, or sent to a model, client, event, or UI. Restart invalidates previously sealed values; cross-process key sources, real external adapters, executors, Sources, external writes, and tools require separate ADRs.

## License

MIT. See [LICENSE](LICENSE).
