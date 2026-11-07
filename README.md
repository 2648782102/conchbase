# Conchbase

**A headless-capable runtime for personal AI agents.**

Conchbase owns agent execution: tasks, model and tool orchestration, policy enforcement, runtime events, and persisted state. It can run from the CLI without a graphical interface. Pagurus and other clients connect through a versioned API.

The first scaffold exposes a local health endpoint. Agent execution, MCP connections, persistent state, and the public task API are planned work.

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

See [the architecture notes](docs/ARCHITECTURE.md) and [API notes](docs/API.md). Chinese: [README.zh-CN.md](README.zh-CN.md).

## License

MIT. See [LICENSE](LICENSE).
