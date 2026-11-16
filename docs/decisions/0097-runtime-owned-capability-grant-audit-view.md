# Decision 0097: Runtime-owned capability grant audit view

Status: **accepted and implemented**

Date: 2026-11-17 (Asia/Shanghai).

## Context

Capabilities are pinned to immutable Agent revisions, while the set of registered tools and Skills belongs to the current Runtime. Clients previously had to join those two facts themselves to answer a simple question: "what can this Agent actually use, and what has gone stale?" That invites a client to invent its own authorization semantics.

ADR 0096 added a manifest-declared plugin loader. That makes this gap more urgent: a plugin tool can be granted to an Agent revision and later become unavailable when the Runtime starts without that plugin. The Runtime already treats an unregistered grant as inert. A read-only audit view makes the fact visible without changing the rule.

## Decision

1. Add `GET /v1/agents/capability-grants`, a read-only Runtime-owned projection.
2. For every Agent, report the grants pinned to its **current** revision and a `stillAvailable` flag computed from the currently registered tool and Skill names.
3. Report stale grants in a dedicated `staleGrants` collection with `agentId` and `revisionId`; a client never has to infer or repair authority.
4. The view is additive: the frozen `1.0.0` contract is unchanged. The exact OpenAPI path set grows by one documented route.
5. The view never changes what a task may call. A grant naming an unregistered capability remains inert, and an Agent with no grants receives no tools or Skills.

## Options

### A. Let the client join Agents with the capability directory

Consequences: each client derives authorization differently, and a mistake in the client looks like a Runtime decision. Rejected.

### B. Add writes so clients can clean stale grants

Consequences: grants are part of an immutable revision; mutating them would break revision history and task pinning. Rejected.

### C. A Runtime-owned read-only projection

Consequences: one authoritative answer, no mutation, and the existing inert-grant rule stays intact. Accepted.

## Consequences

Pagurus and third-party clients can show "granted but unavailable" directly. Plugin and git capabilities follow the same audit path as built-ins. The Runtime remains the only place that interprets a grant.
