# Decision 0027: Optional human-facing visual overview

Status: **accepted repository documentation boundary; no public API contract changes**

Date: 2026-11-11 (Asia/Shanghai).

## Context

The paired `1.0.0` releases are immutable publication snapshots. The repositories are developed primarily by AI coding agents and already have a machine-readable target-mode status index, a canonical reading order, accepted ADRs, OpenAPI, and executable guardrails. A hand-drawn overview can help a human understand the two-repository architecture and ADR gates quickly, but it can also become a second, drifting source of truth if added to the AI reading packet or release notes.

## Options

### A. Keep the visual only in conversation

Consequences: no repository maintenance cost, but no durable human-facing orientation artifact. Rejected by product direction for this slice.

### B. Add the original interactive visualization fragment

Consequences: keeps conversation styling, but depends on host CSS variables and scripts that GitHub Markdown strips; creates an unreadable repository file with a second visual state. Rejected.

### C. Add one static SVG and an explicitly non-authoritative Chinese overview page

Consequences: a durable, script-free visual for humans while keeping the AI contract packet unchanged. Conchbase owns one SVG; Pagurus links to it. A small guardrail checks the non-authoritative disclaimer and the static boundary. Accepted.

## Decision

1. `docs/assets/conchbase-status-doodle.svg` is a static, script-free, self-contained human-facing illustration. It contains no runtime state, credentials, machine-specific paths, external network references, executable test counts, release-specific asset claims, or numeric status claims in visible text.
2. `docs/VISUAL_OVERVIEW.zh-CN.md` labels the image as optional and non-authoritative. It is not part of `aiEntry.requiredOrder`.
3. `README.md` and `README.zh-CN.md` may link to the overview page as an optional human reading aid. They must also state that it is not a contract source of truth.
4. Pagurus does not copy the SVG. Its README files link to the fixed Conchbase `main` overview page and label the link as optional, non-authoritative, and human-facing.
5. `docs/RELEASE_NOTES_1.0.0.zh-CN.md`, Pagurus's corresponding release notes, attached `v1.0.0` Release assets, and the `v1.0.0` tags remain unchanged. This documentation slice is not a new release.
6. Both repositories' guardrails verify the optional overview's link/disclaimer boundary and that the SVG is static, self-contained, and free of hardcoded validation counts, numeric visible text, or external calls.

## Executable boundary

- Run `npm run check`, `npm test`, and `npm run build` in both repositories.
- Add no dependency, public route, database owner, provider adapter, external source, tool executor, generic secret resolver, credential, user data, or machine-specific path.
- Do not put the visual in `PROJECT_STATUS.json`, `OBJECTIVE_MODE.zh-CN.md`, `AI_HANDOFF.md`, `AI_DEVELOPMENT.md`, or the AI task queue.

## Consequences

Humans gain one scannable orientation page without giving a weaker coding model a competing source of truth. The AI reading order and frozen `1.0.0` contract are unchanged. Conchbase owns the only visual file; Pagurus keeps a stable link.

> Documentation boundary only: this ADR adds an optional illustration, not implemented behavior, a public contract, or a release.
