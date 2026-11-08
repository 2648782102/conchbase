# Reference projects: GitHub Trending snapshot

Status: research notes observed on 2026-11-07 (Asia/Shanghai). This is a time-boxed snapshot, not a current ranking, product contract, or accepted architecture. GitHub Trending positions, repository metadata, and README claims change; re-check before treating any item as current evidence. No code was copied from these projects, and their licenses vary. Verify license compatibility before reusing implementation.

## Method and scope

- Read [GitHub Trending daily](https://github.com/trending?since=daily), [weekly](https://github.com/trending?since=weekly), and [monthly](https://github.com/trending?since=monthly), then selected agent, MCP, Skills, plugin, and control-surface projects.
- Read public READMEs, [OpenBot architecture notes](https://github.com/nightly-labs/openbot/tree/main/docs/architecture), and the [Agent Skills specification](https://agentskills.io/specification.md).
- Classified projects by boundary and reusable pattern. Star growth is evidence of attention, not evidence of correctness or suitability for Conchbase.
- Kept `docs/openapi.yaml` unchanged. These observations do not authorize a write route, generated client, provider SDK, storage driver, or configuration form.

## Client and runtime products

- [OpenBot](https://github.com/nightly-labs/openbot) (weekly): local-first desktop workspace with multiple provider adapters, persistent agents, queues, workspaces, Skills, and MCP configuration. Its [structure notes](https://github.com/nightly-labs/openbot/blob/main/docs/architecture/structure.md) describe a contracts package with no UI/Electron/provider dependencies, a local database as the state source of truth, and provider code that cannot write UI state. Adopt the **boundary discipline** and the idea that the runtime owns durable state. Do **not** adopt its documented default `danger-full-access` / `approvalPolicy: never`; Conchbase keeps policy and approval authority.
- [T3 Code](https://github.com/pingdotgg/t3code) (weekly and monthly): a local server plus Web, desktop, and mobile control surfaces for external agent CLIs. Adopt the **UI-optional, multi-client** product shape. Do not let a control surface own the agent loop or become a second API source of truth; Conchbase clients use the versioned Runtime API.
- [claude-mem](https://github.com/thedotmack/claude-mem) (weekly and monthly): a memory/context capability installed into many agent harnesses. Adopt the idea of a **replaceable capability service** with an explicit boundary. Reject account sign-in, cloud sync, telemetry, and provider-specific hooks as runtime defaults; those need separate privacy and local-first decisions.
- [NVIDIA/auto-ontology](https://github.com/NVIDIA/auto-ontology) (daily): an ontology/context layer exposed through MCP, CLI, and API with provenance and validation. Adopt **explicit contracts and provenance for context services**. Reject its Postgres/NIM/web-stack footprint as a Conchbase baseline.
- [worktrunk](https://github.com/max-sixty/worktrunk) (weekly): Git worktree isolation for parallel coding agents. Adopt the general principle of **workspace isolation**. Do not assume Git worktrees are Conchbase's only or default isolation model.
- [REA](https://github.com/morluto/rea) (monthly): a domain-specific tool service exposed as one MCP server. Adopt the **narrow MCP tool-service boundary**. Do not treat this reverse-engineering product as an agent-runtime template.

## Skills, plugins, and validation

- [anthropics/skills](https://github.com/anthropics/skills) (weekly) and [google/skills](https://github.com/google/skills) (daily): portable, file-based Agent Skills catalogs. The [specification](https://agentskills.io/specification.md) defines `SKILL.md` frontmatter, progressive disclosure, and optional `scripts/`, `references/`, and `assets/` directories. Adopt **portable, declarative, versionable instruction packages**. The spec marks `allowed-tools` as experimental; it must not become a permission grant in Conchbase.
- [anthropics/knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins) (monthly): declarative plugin bundles with `plugin.json`, `.mcp.json`, `commands/`, and `skills/`. Adopt the separation between **manifest, MCP connections, explicit commands, and instruction content**. Do not treat a bundle as trusted executable code or as an accepted Conchbase public schema.
- [obra/superpowers](https://github.com/obra/superpowers) (weekly): a Skills-driven software-development methodology: clarify intent, write a plan, use TDD, review, and verify before completion. Adopt this as **AI-development guidance**, not as a built-in agent topology or mandatory user workflow.
- [cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill) (daily and monthly): a Skill that produces structured findings and coverage ledgers checked by zero-dependency validators, with independent verification. Adopt **machine-checkable artifacts, deterministic validators, and adversarial verification**. Do not add its security-audit workflow to the runtime as a built-in feature.
- Other Skills/content repositories on the daily and weekly lists, including [mattpocock/skills](https://github.com/mattpocock/skills), [jakubkrehel/skills](https://github.com/jakubkrehel/skills), [Nutlope/hallmark](https://github.com/Nutlope/hallmark), and [pbakaus/impeccable](https://github.com/pbakaus/impeccable), reinforce that portable instruction packages are an ecosystem pattern. They are content examples, not runtime architecture.

## Boundaries reinforced by this snapshot

- Conchbase remains the execution authority; CLI, Pagurus, IDEs, and third-party clients consume the Runtime API.
- User-defined agent composition is a product direction, not a fixed hierarchy. A layered multi-role arrangement is one illustrative configuration; the runtime must not hardcode layer counts, role names, or coordination patterns. See [ADR 0005](decisions/0005-user-defined-agent-topology-proposal.md).
- Provider adapters, Skills, plugins, MCP servers, and memory/context services are replaceable inputs. None owns durable task state, policy decisions, or the public API. See [ADR 0006](decisions/0006-provider-adapter-capability-boundary-proposal.md) and [ADR 0007](decisions/0007-skill-plugin-mcp-configuration-proposal.md).
- Every tool call remains behind the runtime policy and approval path. A Skill does not grant tool permissions; `allowed-tools` is not authority.
- Loopback-only binding, no authentication/pairing design, and no remote management surface remain current repository facts. The accepted local configuration write routes are documented in `docs/openapi.yaml`.

## Do not infer

- Trending presence does not mean a project is stable, secure, permissively licensed, or compatible with local-first operation.
- Similar product language does not imply the same execution boundary. OpenBot and T3 Code primarily orchestrate external provider CLIs; Conchbase is intended to own its agent loop.
- A popular Skill or plugin layout does not settle Conchbase's profile schema, migrations, secret references, MCP lifecycle, plugin isolation, task IDs, event envelopes, or replay semantics.
- These notes do not accept ADRs `0002`–`0007` as public contracts. Accepted public API slices are recorded in later ADRs and `docs/openapi.yaml`; product direction is still required before implementing new write routes or generated client types.

## Resulting repository records

- [ADR 0005](decisions/0005-user-defined-agent-topology-proposal.md): topology-neutral, user-defined agent composition.
- [ADR 0006](decisions/0006-provider-adapter-capability-boundary-proposal.md): provider adapter and capability boundary.
- [ADR 0007](decisions/0007-skill-plugin-mcp-configuration-proposal.md): Skill, plugin, MCP, and configuration-revision boundary.
- [ADR 0008](decisions/0008-sqlite-driver-compatibility-proposal.md): dated, local SQLite driver compatibility evidence with no production driver selection.
- [ADR 0009](decisions/0009-ai-development-guardrails.md): accepted, executable development guardrails based on deterministic validators.
- [AI task queue](AI_TASK_QUEUE.md): current implemented facts, blocked work, and the next independent implementation slice.

## Later product direction (2026-11-07)

This snapshot remains dated research. [ADR 0010](decisions/0010-first-real-model-slice.md) now records accepted phase-1 direction for a real-model task slice, durable events, explicit retry, and a narrow Magpie provider adapter. It does not retroactively accept the broader proposal contracts or add a GitHub Trending observation.

[ADR 0016](decisions/0016-composition-execution-and-public-schema.md) later accepts the bounded public composition configuration section and deterministic execution contract. [ADR 0017](decisions/0017-public-tool-request-approval-ledger.md) accepts a public request/approval ledger without execution. [ADR 0018](decisions/0018-provider-tool-call-parsing-boundary.md) accepts an internal pure parser for one non-streaming provider function tool call but keeps provider adapter integration, executor isolation, and crash-safe side effects open. The reference snapshot remains product-direction evidence, not an execution or security design.
