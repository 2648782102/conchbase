# Decision 0007: Skill, plugin, MCP, and configuration boundary (proposal)

Status: **proposed, not accepted as a public contract**

## Context

ADR `0004` proposes content-addressed configuration revisions for portable profile, Skill, policy, and MCP-server identifiers. It does not define a portable file format, composition topology, bundle manifest, migration policy, secret references, or public configuration API.

`docs/REFERENCE_PROJECTS.md` records three relevant ecosystem patterns: the Agent Skills `SKILL.md` folder format, declarative plugin bundles in `anthropics/knowledge-work-plugins`, and OpenBot's explicit bridging of Skills and MCP settings across several provider-specific folders. The Agent Skills specification marks `allowed-tools` as experimental.

`AGENTS.md` requires that a Skill supplies instructions but does not grant tool permissions, that arbitrary in-process plugins remain out of scope until isolation is designed, and that a UI never reads or writes Conchbase private files.

## Options

### A. Declarative bundles plus a runtime-owned registry (recommended)

- A versioned, user-authored profile references declarative Skill, plugin-descriptor, policy, and MCP-server records. The whole profile is pinned in one configuration revision per task.
- Conchbase owns discovery, validation, installation state, capability grants, MCP process lifecycle, secret references, and the authoritative registry. Pagurus and other clients use the public Runtime API only.
- A Skill is instruction content. Experimental `allowed-tools` metadata may be recorded as a requested capability hint, but final authorization always comes from the runtime policy and approval path.
- A plugin descriptor is data until an accepted isolation, lifecycle, and grant model exists. Do not load arbitrary plugin code in-process.
- MCP tools remain independently permission-gated. Installing, enabling, granting, and approving are separate operations.

Consequences: portable, auditable, and compatible with topology-neutral composition. Requires future decisions on schemas, validation errors, migrations, rollback, import/export, display ordinals, secret-store interfaces, and MCP sandboxing.

### B. Copy provider-specific configuration folders

Write Skills and MCP settings directly into each provider CLI's home or project folders and let those CLIs own discovery.

Consequences: practical for a multi-provider harness, but it creates duplicate sources of truth, provider-coupled behavior, and unclear revocation. OpenBot's documentation illustrates the complexity. Rejected for Conchbase's authoritative runtime registry.

### C. Let Skills or plugins declare their own grants

Treat `allowed-tools`, plugin manifests, or embedded scripts as sufficient authority to execute tools.

Consequences: convenient packaging, but untrusted instruction content becomes a permission escalation path. Rejected because tool execution must always pass the runtime policy and approval path.

## Recommendation

Keep option A as a **proposed boundary**, not an accepted profile schema. Do not add configuration write routes, generate client types, build Pagurus forms, introduce a plugin host, install an MCP SDK, or copy provider-specific files. Any future `SKILL.md` compatibility work must treat scripts and references as untrusted data and must not execute them without an explicit policy decision.

Before locking a public contract, obtain product direction on profile/config schema, validation preview, revision history and rollback, secret references, MCP lifecycle and sandboxing, per-tool grants, plugin trust/isolation, and import/export.

## Validation

No bundle loader or configuration API exists yet. Future deterministic validation must use dependency-free bundle fixtures with no real credentials, personal data, or network calls; assert that invalid frontmatter/manifests are rejected, Skills cannot grant tools, secrets never enter events or logs, installation/enabling/granting remain distinct, and a task keeps its pinned configuration revision after a newer profile is applied.
