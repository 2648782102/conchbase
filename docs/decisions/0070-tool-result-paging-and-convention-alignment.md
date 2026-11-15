# Decision 0070: Tool-result paging and convention alignment

Status: **accepted and implemented additive interoperability changes**

Date: 2026-11-15 (Asia/Shanghai).

## Context

Three gaps surfaced from comparing Conchbase with established agent-runtime and client-protocol practice:

1. **Silent truncation.** `workspace_read` returned the first bounded slice of a file with no indication that more existed. A model reasonably treated the fragment as the whole answer. The same applied to `workspace_list` and `text_search`, which stopped at their caps without saying so.
2. **Private telemetry vocabulary.** The durable event log carried complete agent-loop facts under Conchbase-owned field names. Any external observability backend would need a bespoke translation layer.
3. **Private stream vocabulary.** Agent Chat SSE frames used a `kind` field with no relationship to any published agent-to-frontend convention, so a third-party client could not consume the stream without Conchbase maintaining an adapter.

All three are interoperability problems. None of them requires changing an accepted public contract; each can be solved additively, which keeps every existing client and ADR valid.

## Decision

### 1. Truncated tool results state how to continue

`src/runtime/tool-result-paging.ts` appends a bounded footer naming the tool argument and value that continue the result. `workspace_read` and `workspace_list` accept an `offset` argument; `workspace_read` rejects an offset past end-of-file with `offset_out_of_range`. Multi-byte UTF-8 characters are never split into replacement characters. The byte cap is unchanged — only the silence around it is removed.

`ToolDefinition` gains an optional `parameters` field, and every built-in tool publishes a JSON-Schema-shaped parameter description. MCP tools already carried `inputSchema` from discovery; that schema now reaches the model instead of being flattened to `additionalProperties: true`.

### 2. Agent-loop events carry additive OTel GenAI attributes

`src/runtime/otel-genai.ts` defines the adopted subset of the OTel GenAI semantic conventions. `TaskService.recordLoopEvent` merges flattened `otel.*` attributes into loop-event `data` alongside the existing fields. Event data remains a flat scalar record, so the attribute keys carry the namespace themselves rather than nesting an object.

Nothing is renamed. The conventions are still marked development upstream, so this is a deliberately chosen stable subset, not a commitment to track every revision.

### 3. Agent Chat frames carry an additive AG-UI mapping

`src/runtime/ag-ui-events.ts` maps each frame onto the closest AG-UI event type. `AgentChatStreamFrame` gains `agUiType`. `kind` remains authoritative under ADR 0060. Frames with no faithful equivalent — transport health — report `null` rather than a misleading label.

### 4. No new dependency

This decision adds no runtime dependency. OTel and AG-UI are adopted as *naming and shape*, not as SDKs. Emitting convention-shaped attributes is sufficient; shipping an exporter or a protocol client would add process-lifetime concerns the Runtime does not need.

## Options

### A. Adopt the OTel SDK and the AG-UI client library

Consequences: real dependencies, real process-lifetime concerns, and a second source of truth for stream semantics. Rejected.

### B. Rename Conchbase's own event and frame vocabularies to match

Consequences: breaks the frozen contracts and every accepted ADR for a naming preference. Rejected.

### C. Additive attributes, additive frame field, explicit paging footers

Consequences: interoperability improves, every existing client and contract stays valid, and no dependency is added. Accepted.

## Validation

- `tests/tool-result-paging.test.ts` covers pass-through, continuation footers, truncation without continuation, multi-byte safety, offset round-trips, out-of-range rejection, list continuation, and published parameter schemas.
- `tests/otel-genai.test.ts` covers attribute names, flattening, empty context, and real durable events carrying both the new attributes and the unchanged existing fields.
- `tests/ag-ui-events.test.ts` covers every message state mapping and asserts every mapped value belongs to the published vocabulary.
- `npm run check`, `npm test`, and `npm run build` pass.

## Consequences

A model can now tell a truncated result from a complete one and continue from an exact offset. An operator can forward events to an OTel-aware backend without a translation layer. An AG-UI client can map the Agent Chat stream without Conchbase maintaining a private adapter. None of this changes a published path, and none of it weakens a bound: the byte cap, the iteration budget, and the approval gate all still apply unchanged.
