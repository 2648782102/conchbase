# Decision 0096: Plugin loader permission model

Status: **accepted and implemented**

Date: 2026-11-16 (Asia/Shanghai).

## Context

`PROJECT_STATUS.json` lists `Skill/plugin loading` under `blockedDirections` with `requiresAcceptedAdr: true`. That is a process gate, not a prohibition. A plugin loader is part of the intended platform: Conchbase should be extensible by third parties without editing core.

The hard part is not loading code; it is deciding what loaded code may do. A plugin that can arbitrarily call tools, read SecretHandles, or open network connections is effectively a new authority outside the Runtime policy and approval path. That would violate the invariant "Never execute a tool outside the runtime policy and approval path" and would make plugins the weakest link.

We already have two safe extension models: MCP (a declared tool provider over stdio with fixed commands and timeouts) and Skills (instruction content with no capabilities). Plugins should sit beside them, not bypass them.

## Decision

### v1 is a manifest-declared tool provider, not arbitrary in-process code

1. **A plugin is a manifest plus a ToolProvider implementation supplied at composition time.** The Runtime never `import()`s an arbitrary path from configuration in v1. This avoids executing unreviewed third-party code inside the process.
2. **The manifest is explicit and bounded.** It declares `id`, `version`, a short `description`, and exact `tools` with `id`, `description`, and `sideEffect`. Unknown fields are rejected, as are duplicate tool ids.
3. **A plugin can only add tools; it cannot grant itself capabilities.** Its tools become available in the Runtime-wide tool directory, but an Agent receives them only if its immutable revision pins the corresponding `CapabilityGrant`. This is the same rule as built-ins, MCP, git, and Skills.
4. **Plugin tools are deny-by-default on consequential side effects.** `sideEffect: 'write'` or `'external'` still goes through the Runtime approval path in restricted mode; a plugin cannot call its own implementation to bypass that gate. The `ToolInvocationGuard` enforces this before any implementation is called.
5. **No SecretHandle access.** Plugins receive no secret values, no generic value resolver, and no handle to the platform store. If a plugin needs credentials, a Runtime-owned fixed adapter must own the exchange behind a declared destination.
6. **No arbitrary arguments beyond the declared tool schema.** The loader validates each tool invocation against a JSON-schema-shaped parameter declaration with `additionalProperties: false` unless explicitly declared otherwise. Model input never reaches plugin code unchecked.
7. **Lifecycle is explicit.** `PluginRuntime` loads manifests at startup and exposes `list`, `has`, `invoke`, and `close`. Nothing is loaded lazily from a prompt or a task.

## Options

### A. `import()` arbitrary plugin modules from a configured directory

Consequences: maximum flexibility, but it executes third-party code with full process privileges and no permission model. Rejected for v1; could be revisited only with a real isolation boundary.

### B. Reuse MCP for everything

Consequences: no new loader, but MCP is a protocol for tool servers, not a general extension model for in-process providers such as git or future memory backends. Rejected as the only answer.

### C. Manifest-declared providers registered at composition time

Consequences: gives plugins first-class ids, discovery, grants, and guard enforcement without executing unreviewed code. Acceptable now; can later add an isolated subprocess backend behind the same `PluginProvider` interface. Accepted.

## Validation

- Manifest fixtures: exact fields, bounded values, duplicate ids, unknown fields, invalid side effects, and schema validation.
- Guard fixtures: ungranted tools rejected, write/external calls paused in restricted mode, unrestricted still cannot bypass grants, plugin invocation receives only declared scalar arguments.
- Directory fixtures: two plugins compose with built-ins without id collisions; a colliding id fails at startup rather than silently shadowing.

## Consequences

Conchbase gains an extension surface that fits its existing authority model: plugins add named tools, Agents must be granted them, and the Runtime still adjudicates every consequential call. A future ADR can add isolated out-of-process plugins behind the same interface without changing Agent revisions.
