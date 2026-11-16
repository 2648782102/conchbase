# Decision 0098: Subprocess plugin provider with explicit capabilities

Status: **accepted and implemented**

Date: 2026-11-17 (Asia/Shanghai).

## Context

ADR 0096 introduced a manifest-declared plugin loader that composes a `ToolProvider` at startup. That is the right authority model, but it does not isolate a plugin from the Runtime process: a third-party implementation written in TypeScript would still run with the process's privileges.

`docs/PLUGIN_REFERENCE.zh-CN.md` records the external review. Three findings drive this decision:

- MCP approval must be separated from install, enable, and grant: approving a server is not granting every Agent the right to call it.
- Capabilities must be declared outside the workload and enforced by the Runtime; a server that self-reports its tools cannot be the authority.
- A stdio child process is **fault isolation, not a security sandbox**. It inherits environment, filesystem access, and network unless those are explicitly constrained.

## Decision

1. **A subprocess plugin is a `ToolProvider` implementation behind ADR 0096.** It does not add a second plugin system. The manifest remains Runtime-owned and fixed; the plugin process cannot expand the declared tool set.
2. **A narrow line protocol.** Tools are invoked as one JSON request on stdin; the plugin replies with one JSON result on stdout. No discovery, no dynamic capability negotiation, no arbitrary control messages.
3. **No inherited environment.** The child receives only the variables declared in the manifest and required injection points. `process.env` is not copied into it.
4. **Bounded execution.** Spawn uses `shell: false`, an argv array, a startup timeout, a per-call timeout, and byte caps on stdout and stderr. A hang or oversized reply fails the tool call rather than the Runtime.
5. **Workspace and network stay Runtime-owned.** The plugin is handed declared input arguments only. It receives no workspace paths unless explicitly declared in its manifest, and no SecretHandle values or generic secret resolver.
6. **Fault isolation only.** The subprocess prevents a plugin crash from taking down the Runtime and makes resource caps enforceable. It is not a sandbox for untrusted third-party code; genuinely untrusted plugins require a later Wasm/container boundary.
7. **Audit reuse.** Subprocess plugin grants appear in `GET /v1/agents/capability-grants` like every other capability; no second permission view is introduced.

## Options

### A. Let the plugin process report tools on startup

Consequences: simpler, but it hands authority to the plugin and recreates the self-declared capability flaw ADR 0096 avoided. Rejected.

### B. Run plugins in-process with a narrow interface

Consequences: fast, but a plugin bug or malicious implementation runs with Runtime privileges and cannot be resource-capped reliably. Rejected as the general external-plugin story.

### C. Fixed manifest, stdio request/response, minimal environment

Consequences: honest fault isolation, bounded resource usage, and one authority model. Accepted.

## Validation

- Manifest fixtures for environment allowlists, bounded timeouts, byte caps, and fixed argv.
- Protocol fixtures reject undeclared tools, malformed JSON, oversized replies, non-zero exits, and timeouts.
- Lifecycle fixtures verify close() terminates the child and a failed plugin never blocks Runtime shutdown.

## Consequences

Conchbase can host trusted-but-fallible external plugins without letting their crashes enter the main process. It must still say clearly that this is not a sandbox; untrusted code remains out of scope until a stronger isolation ADR exists.
