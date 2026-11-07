# Decision 0006: Provider adapter and capability boundary (proposal)

Status: **proposed, not accepted as a public contract**

Accepted direction: [ADR 0010](0010-first-real-model-slice.md) accepts a narrow, runtime-owned provider adapter and selects a direct OpenAI Chat Completions-compatible implementation for Magpie in phase 1. Broader provider capability discovery, streaming, structured tool calls, and vendor SDK selection remain open.

## Context

`docs/AI_HANDOFF.md` already requires provider SDKs to sit behind a replaceable adapter and forbids them from owning security decisions or durable task state. `docs/REFERENCE_PROJECTS.md` records that OpenBot and T3 Code support multiple provider CLIs, while OpenBot's own README warns that its default full-access mode bypasses per-action approval.

Conchbase must remain independent of any provider's session state, approval policy, Skills folders, MCP configuration format, and durable event model. At the same time, the public Runtime API must stay usable by CLI, graphical, and third-party clients.

## Options

### A. Narrow, runtime-owned provider adapter (recommended)

- An internal adapter accepts a bounded turn request and returns structured model output, tool-call requests, completion, failure, and cancellation signals. It receives an `AbortSignal` and deterministic fixture inputs.
- The runtime owns task state, composition interpretation, policy gates, approvals, event log, configuration revision pinning, and tool execution. Provider output is untrusted data.
- Capability discovery is explicit and versioned. Provider-specific settings remain behind the adapter; they do not leak into the public Runtime API or client-generated types.
- The adapter contract does not assume any agent topology, role count, or coordination pattern. ADR `0005` keeps composition topology-neutral.

Consequences: provider replacement does not change durable state or security semantics. Requires careful future compatibility checks for streaming, structured tool calls, cancellation, token/context limits, and error classification.

### B. Provider-driven state and permissions

Mirror one selected provider SDK's run state, approvals, tools, and durable session semantics.

Consequences: less initial translation, but the runtime's public behavior changes with the provider, and provider credentials or settings can become an implicit authority. Rejected because Conchbase owns the agent loop and policy path.

### C. External CLI as execution authority

Treat an installed agent CLI or app server as the owner of tasks, permissions, and state; Conchbase becomes a client or UI bridge.

Consequences: useful for harness/control products, but it contradicts the accepted execution-authority boundary and makes custom composition dependent on a vendor CLI. Rejected for the Conchbase core. A separate compatibility adapter may be considered later only if it does not replace the Runtime API.

## Recommendation

Keep option A as a **proposed internal boundary**. Do not choose a provider SDK, add real credentials, perform network calls, change `docs/openapi.yaml`, or expose adapter-specific operations. The existing `src/runtime/model-adapter.ts` is an internal deterministic contract; it is not evidence that a real provider loop exists.

Before locking a public contract, obtain product direction on provider capability discovery, error/cancellation semantics, credential references, local-model endpoints, and the order of supported providers.

## Validation

Current internal fake-model tests already prove success, failure, and cancellation terminal paths without a later tool execution. Future provider conformance checks must use a fake provider, no API keys, no public network, and no real tool execution; they must assert that a provider cannot bypass the policy gate, write events directly, or change a task's pinned configuration revision.
