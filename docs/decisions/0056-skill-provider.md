# Decision 0056: Skill instruction provider

Status: **accepted and implemented read-only Skill provider**

Date: 2026-11-15 (Asia/Shanghai).

## Context

ADR 0052 accepts a capability-provider seam; ADR 0053 and 0054 implement built-in read-only tools and MCP. Skills are different: the Agent Skills ecosystem distributes `SKILL.md` folders that describe *how* to work, not tools the Runtime executes. Archived ADR 0007 records the intended boundary: a Skill supplies instructions and never grants capabilities. Its experimental `allowed-tools` field is a hint, not authority.

## Decision

1. Skills are **administrator-configured**. `CONCHBASE_SKILLS_DIR` points at a local directory whose immediate subdirectories contain `SKILL.md`. The Runtime reads it at startup; a model, Agent revision, client, or MCP server cannot add a Skill.
2. Only `SKILL.md` is read. Nothing else in the folder is loaded, executed, or imported. Scripts, references, assets, and `allowed-tools` are ignored entirely; they grant nothing and run nothing.
3. Parsing accepts optional YAML-style front matter with `name` and `description`, followed by the instruction body. Missing front matter falls back to the directory name. A Skill without a non-empty body is skipped.
4. Injection is bounded: at most 8 Skills and at most 8 KiB of combined instruction text per Agent turn. Exceeding either bound truncates deterministically at the boundary; it never fails the task.
5. Instructions are inserted as one system message in the Agent loop, clearly labelled as user-provided guidance that cannot override Runtime policy, tool authorization, or approval. They are never inserted into events, task rows, client responses, or logs as raw content.
6. Path handling rejects `..` traversal, absolute paths inside the declaration, and symbolic links that resolve outside the Skills root.
7. No public path, schema field, database table, or client surface is added. Skills do not become tools, do not appear in the model catalog, and cannot be invoked by name from a model tool call.

## Options

### A. Load Skill scripts and treat `allowed-tools` as grants

Consequences: untrusted instructions become execution authority. Rejected.

### B. Expose Skills as callable tools

Consequences: conflates instructions with capability and duplicates the loop. Rejected.

### C. Inject bounded instruction text into the Agent loop

Consequences: real Skills compatibility with no new authority. Accepted.

## Validation

- `tests/skill-provider.test.ts` covers front-matter parsing, missing front matter, empty body skipping, `allowed-tools` being ignored, size and count bounds, traversal and symlink rejection, and loop injection.
- Both repositories pass `npm run check`, `npm test`, and `npm run build`.

## Consequences

Users can drop standard `SKILL.md` folders into one directory and have Agents follow them, without granting any new capability. Skill installation, versioning, per-Skill selection, and plugin hosts remain blocked pending their own ADRs.
