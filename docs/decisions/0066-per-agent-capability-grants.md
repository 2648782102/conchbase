# Decision 0066: Per-Agent capability grants

Status: **accepted and implemented per-Agent capability grants**

Date: 2026-11-15 (Asia/Shanghai).

## Context

ADR 0052 says the Runtime decides "whether the pinned Agent revision and runtime policy allow" a tool. That is not what the code does.

`TaskService.executeAgentLoop` reads `this.loopOptions.tools` and `this.loopOptions.skills` — two Runtime-wide singletons built once at startup in `src/main.ts`. Every Agent, including every dynamically hired worker, therefore receives every registered built-in tool, every allowlisted MCP tool, every loaded Skill directory, and (when `CONCHBASE_ALLOW_TOOL_WRITES=1`) the write tool. The `capability-directory` from ADR 0025 has no reader: `SqlitePlatformStore.putCapability` writes records that no authorization path consults.

This contradicts the paired product direction ("用户在寄居蟹里配置自己的 Agent 的 MCP、Skill、插件") in the most visible way: configuring a capability changes nothing, and no Agent can be narrower than the global maximum. It also breaks the ADR 0052 approval identity, which is supposed to bind to the pinned Agent revision.

This is not one of the `blockedDirections`. It adds no external side effect, no new provider, no network tool, and no secret access. It only changes which already-registered capabilities a given Agent may see.

## Decision

1. An Agent revision carries an explicit, bounded capability grant list: `grantedCapabilities`, an array of `{ kind, name }` where `kind` is `tool` or `skill` and `name` is the existing capability identifier (`workspace_read`, `mcp_<server>_<tool>`, or a Skill directory name).
2. The grant list is part of the immutable Agent revision, not Runtime state. Editing grants follows the existing create-revision / `expectedRevisionId` path, so a task pinned to `agr_a` keeps `agr_a`'s grants after the Agent moves to `agr_b`.
3. Grants can only narrow. The effective tool set for a task is `loopOptions.tools ∩ grantedCapabilities(tool)`. The effective Skill set is `loopOptions.skills ∩ grantedCapabilities(skill)`. A grant naming a capability the Runtime does not register is inert, never an error, so an Agent revision stays valid when an administrator removes an MCP server.
4. An empty grant list means **no capabilities**. It does not mean "all". Fail-closed is required because the previous behavior silently handed every Agent the maximum authority.
5. Grant filtering happens in one place: `TaskService` builds a per-task projected `ToolProvider` and Skill list before assembling provider messages, and every later path (`runAgentLoop`, `drainToolCalls`, `resumeApprovedTool`) uses that projection. A tool the model names but the task was not granted resolves as `unknown_tool`, exactly like an unregistered tool. The model is never told about tools it cannot use.
6. Approval identity is unchanged in shape but now provably Agent-scoped: a checkpoint belongs to a task, a task pins an Agent revision, and that revision fixed the grant list. Resuming an approved write re-derives the projection from the same pinned revision before invoking.
7. `GET /v1/agents` and `GET /v1/agents/{agentId}` publish each revision's `grantedCapabilities`, so a client can show what an Agent may use. `POST /v1/agents` and `PATCH /v1/agents/{agentId}` accept the same field. This is additive to the existing `agents` capability: the Agent Chat and task contracts do not change.
8. The field is validated: at most 64 entries, `kind` from a closed set, `name` at most 120 characters matching `^[a-z0-9][a-z0-9_.-]*$`, no duplicates after `(kind, name)` normalization, sorted for stable digests.
9. Existing Agents migrate with an empty grant list. That is a deliberate narrowing: after this ADR an Agent without grants cannot call tools. Operators and the Boss's dynamic-worker path must grant what they intend to allow.
10. The Boss dynamic-worker path grants a conservative fixed set: the read-only built-ins plus any Skill the Runtime has loaded. It does not grant writes, MCP, or plugin capabilities implicitly.
11. Private schema advances to `PRAGMA user_version = 8` with an additive `granted_capabilities` TEXT column on `agent_revisions`. Replay and reopen preserve existing revisions; the migration default is the empty array.
12. No public path is added. No `blockedDirections` item is unblocked, and no real MCP lifecycle, external Source, external write, plugin host, or secret injection is introduced.

## Options

### A. Keep Runtime-wide tools and document it as a known limitation

Consequences: "configure your Agent's capabilities" stays false, the capability directory remains write-only decoration, and the narrowest possible Agent is still the global maximum. Rejected.

### B. Add a Runtime-wide allowlist and let clients filter in the UI

Consequences: clients would hold authority, a second client could show a different set, and a model could still call anything. ADR 0052 forbids client-side authority. Rejected.

### C. Put grants on the immutable Agent revision and filter in `TaskService`

Consequences: authority is versioned, pinned per task, enforced in one place, fail-closed by default, and visible to every client through one schema. Accepted.

## Validation

- `tests/agent-capability-grants.test.ts` asserts an Agent with no grants cannot call a registered tool (`unknown_tool`), an Agent granted `workspace_read` can, a task pinned to an older revision keeps the older grants after the Agent is edited, and a grant for an unregistered capability is inert.
- A Skill-grant fixture asserts an ungranted Skill's instructions never reach the provider messages.
- `tests/agent-api.test.ts` asserts grants round-trip through create, patch, list, and detail, and that invalid kinds, duplicate entries, and over-long names are rejected with `400`.
- `tests/agent-migration.test.ts` asserts a `user_version = 7` database migrates to `8` with existing revisions keeping their data and an empty grant list.
- `npm run check`, `npm test`, and `npm run build` pass.

## Consequences

Agent identity now bounds capability, which is what the product promised. The change is intentionally breaking at the behavior level — an Agent that could read the workspace yesterday cannot today until granted — and that break is the point: fail-closed is safer than silently maximum authority. Grant lists are revisioned, so audit can answer "what could this Agent use when this task ran" from the task's pinned revision alone.

MCP and Skill lifecycle remain administrator-configured at startup. Pagurus gains a grant editor over the existing Agent profile contract; it still never computes authority.
