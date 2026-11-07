# Conchbase

**A headless-capable runtime for personal AI agents.**

[![CI](https://img.shields.io/github/actions/workflow/status/2648782102/conchbase/ci.yml?branch=main&label=CI)](https://github.com/2648782102/conchbase/actions/workflows/ci.yml) [![MIT License](https://img.shields.io/github/license/2648782102/conchbase)](LICENSE) [![Node.js 24+](https://img.shields.io/badge/Node.js-24%2B-43853d)](https://nodejs.org/)

Conchbase owns agent execution: tasks, user-defined agent composition, model and tool orchestration, policy enforcement, runtime events, and persisted state. It can run from the CLI without a graphical interface. Pagurus and other clients connect through a versioned API. User-authored composition is intended to be topology-neutral; a layered multi-role setup is one example, not a built-in structure or default. See the [proposal ADR](docs/decisions/0005-user-defined-agent-topology-proposal.md).

The current scaffold exposes local health and runtime status endpoints. It also includes internal, tested domain primitives for future task lifecycle, event ordering, configuration revisions, tool policy decisions, and a provider-independent fake-model acceptance fixture. Agent execution, MCP connections, persistent state, and the public task API are planned work; the internal primitives are not wired into HTTP and do not call a real model or tool. Deterministic repository guardrail tests keep the current read-only contract and AI-first boundaries explicit.

## Current status

Early development. The API and runtime boundaries are being established before adding model and tool execution.

## Run locally

Requirements: Node.js 24 or newer.

```sh
npm install
npm run dev
```

The service listens on `127.0.0.1:4318` by default and currently allows loopback addresses only. Check it with:

```sh
curl http://127.0.0.1:4318/v1/health
```

Set `CONCHBASE_HOST` to `localhost`, `127.0.0.1`, or `::1`, and `CONCHBASE_PORT` to change the local bind address and port. Network binding will require authentication and pairing.

## Architecture

- The runtime owns task execution and permission enforcement.
- CLI, Pagurus, and third-party interfaces are clients of the runtime API.
- MCP provides tool connections; Skills provide agent instructions.
- A task uses a stable configuration snapshot for its lifetime.
- The runtime does not hardcode a role count, hierarchy, or coordination pattern; highly customizable composition is planned work, not current behavior.

See [the architecture notes](docs/ARCHITECTURE.md), [current API](docs/API.md), and [OpenAPI contract](docs/openapi.yaml). New coding models should start with the [AI handoff](docs/AI_HANDOFF.md), then the [AI task queue](docs/AI_TASK_QUEUE.md), the [reference-project notes](docs/REFERENCE_PROJECTS.md), and the proposal ADRs in `docs/decisions/`. Chinese: [README.zh-CN.md](README.zh-CN.md).
See also the [technology baseline](docs/TECH_STACK.md), [roadmap](docs/ROADMAP.md), and [validation plan](docs/VALIDATION_PLAN.md). The companion console is [Pagurus](https://github.com/2648782102/pagurus).

## AI-first development

This project is developed primarily by AI coding agents. Architecture, documentation, and validation are optimized for fast context loading, bounded changes, and deterministic verification; future human handoff is not a product requirement. Start with [`AGENTS.md`](AGENTS.md), then read the [AI handoff](docs/AI_HANDOFF.md) and [development guide](docs/AI_DEVELOPMENT.md).

## License

MIT. See [LICENSE](LICENSE).
