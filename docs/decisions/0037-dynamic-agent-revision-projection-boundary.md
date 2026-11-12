# Decision 0037: Dynamic Agent revision projection boundary

Status: **accepted internal implementation boundary; no public API contract changes**

Date: 2026-11-13 (Asia/Shanghai).

## Context

ADR 0032 accepts the direction that a model's `create_agent` output is untrusted and may become an immutable Agent revision only after Runtime validation. The organization kernel records a bounded `create_agent` action with `displayName`, `instructionsDigest`, provider-neutral model reference, Delegation, scope, and capabilities. The existing Agent resource accepts a full profile with actual instruction text and validates model references through `TaskService`.

A later Runtime bridge must not pretend a digest is instruction text, must not let organization prose grant capability, and must not bypass the existing Agent revision and model-validation boundaries.

## Decision

1. `organization-agent-projection.ts` is a pure internal boundary that projects an accepted organization `create_agent` action into an explicit `DynamicAgentProfileProposal`: display name, instruction digest reference, provider-neutral model, owning project, delegation, and bounded authority metadata. It is not an `AgentProfile` and is not executable.
2. The projection must be deterministic, reject secret-like values and paths, preserve provider-neutral model references, and keep Agent instructions as an opaque digest. It must not synthesize instruction text from the digest or from model prose.
3. Only the existing Runtime service may turn a proposal into a stored Agent revision. That future step must supply actual bounded instruction content through the accepted Agent profile boundary, keep the proposal digest as internal audit metadata, and retain existing model-catalog validation. This ADR does not bypass those checks.
4. The organization layer records the projected revision reference as an opaque value. No new capability is granted by projection; authority continues to come only from the accepted Delegation and runtime-wide policy.
5. The 47-path `1.0.0` contract remains frozen. A future public contract ADR must define any client-visible dynamic Agent proposal or audit surface.

## Options

### A. Decode a digest into instructions

Consequences: impossible without an external store and would turn an integrity value into content. Rejected.

### B. Create Agent revisions directly from organization actions inside the store

Consequences: bypasses `TaskService` profile and model validation and creates a second writer of Agent state. Rejected.

### C. Project a bounded proposal, then bridge explicitly through existing Agent validation

Consequences: preserves Runtime authority and auditable evidence while leaving actual text and model validation to the existing boundary. Accepted.

## Validation

An executable fixture must prove:

- a valid `create_agent` action projects with stable identity and bounded fields;
- plaintext, paths, URLs, and secret-like values are rejected;
- instructions remain digest-only and are never synthesized;
- provider/model references stay provider-neutral;
- capability/scope data is carried as audit metadata and does not grant authority;
- no direct Agent store write, HTTP route, or public OpenAPI change exists.

## Consequences

The organization layer can describe a future Agent revision safely without inventing a second Agent schema. Connected dynamic creation remains gated on a later Runtime-service slice and never on model output alone.

> Internal implementation boundary only: this ADR accepts a pure proposal projection, not a stored Agent revision or public API.
