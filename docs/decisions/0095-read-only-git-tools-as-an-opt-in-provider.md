# Decision 0095: Read-only git tools as an opt-in provider

Status: **accepted and implemented**

Date: 2026-11-16 (Asia/Shanghai).

## Context

The Runtime can read and write files inside a workspace, but it understands nothing about version control. That is a real gap rather than a missing integration:

- A worker edits files and cannot answer "what did I change?".
- A project close-out report cannot say which files changed.
- `git log` and `git blame` are the fastest way to learn why code looks the way it does.

Two earlier framings were wrong and are corrected here:

1. Calling this "GitHub integration" conflated two different things. Git is a local capability with no credentials and no network; GitHub is a replaceable remote provider that needs a token.
2. Claiming a repository rule forbade plugins was a fabrication — `AGENTS.md` says nothing about plugins. The actual constraint is in `PROJECT_STATUS.json`: `Skill/plugin loading` sits under `blockedDirections` and needs an accepted ADR. That is a process gate, not a prohibition, and it does not apply to git.

## Decision

1. **Git is a local capability, not a provider integration.** It is registered by `createToolRuntime` alongside the built-in tools, not behind MCP or a plugin host.
2. **Off by default, enabled explicitly.** `CONCHBASE_ENABLE_GIT_TOOLS=1` mirrors the existing `CONCHBASE_ALLOW_TOOL_WRITES` precedent: an operator opts in, and nothing is granted implicitly.
3. **Read-only, and marked as such.** The three tools declare `sideEffect: 'read'`, so they never enter the approval path and never write to the repository.
4. **Fixed subcommands only.** `git_status`, `git_diff`, and `git_log` map to exact argument vectors. A model cannot supply flags, paths, or revisions that become new argv entries.
5. **No shell.** Subprocesses run with `shell: false` and an argument array, which removes shell metacharacter injection entirely.
6. **Bounded.** Every invocation is confined to the workspace root (via `cwd`, never `-C`), has a timeout, and has an output byte cap consistent with the other tools.
7. **Absent git is a clean failure.** If the binary is missing or the directory is not a repository, the tool returns a bounded error code rather than throwing into the loop.

## Why not a plugin

A plugin host exists to run third-party code with a permission model. Git is neither third-party nor arbitrary: it is a known binary invoked with known arguments inside a directory the Runtime already owns. Putting it behind a plugin host would require building that host first — including its permission model — to solve a problem that does not need it.

The plugin loader is still worth building, on its own schedule and with its own ADR, for genuinely replaceable extensions. It is not a prerequisite for git and must not block it.

## Options

### A. Ship git as a plugin

Consequences: forces construction of a plugin host and its permission model before any version-control capability exists, and pretends git is optional third-party code. Rejected.

### B. Add git into `createBuiltinReadTools`

Consequences: blurs the premise that built-ins are pure filesystem operations, and introduces subprocess execution into the tool every environment gets by default. Rejected.

### C. A separate opt-in provider with fixed commands

Consequences: keeps the default surface free of subprocesses, makes the risk explicit and configurable, and reuses the existing provider composition. Accepted.

## Validation

- Unit fixtures cover: fixed argument vectors, no-shell invocation, workspace confinement, absent-binary handling, non-repository directories, output caps, and that no write subcommand is reachable.
- Behaviour is asserted on parsed output rather than raw text where the tool returns structured data.

## Consequences

Operators who enable it gain version-control context for workers and close-out reports. The default Runtime still executes no subprocess for tools, and the three tools cannot mutate a repository. A plugin loader remains a separate, ADR-gated piece of work.
