# Decision 0005: User-defined agent topology (proposal)

Status: **proposed, not accepted as a public contract**

Product direction: **accepted as intent, not implemented**. Conchbase should let a user define a highly customizable agent. A layered arrangement with several specialized roles is only an illustrative example. It is not a built-in structure, default template, preferred topology, or schema.

Phase-1 boundary: [ADR 0010](0010-first-real-model-slice.md) implements a single-turn execution unit for real-model validation. This is an implementation slice, not a canonical single-agent topology and not a rejection of future user-authored compositions. [ADR 0015](0015-composition-identity-kernel.md) later accepts an internal, topology-neutral identity kernel for deterministic graph fixtures. [ADR 0016](0016-composition-execution-and-public-schema.md) accepts a bounded public graph representation, deterministic execution order, node events, and cancellation propagation; it does not accept model-driven node work, delegation, concurrency, role registries, or general coordination semantics. This record remains a proposal for the broader public contract.

## Context

`AGENTS.md` and `docs/AI_HANDOFF.md` establish Conchbase as the execution authority. The current repository has read-only status endpoints and internal deterministic primitives; it has no agent loop, profile schema, role registry, provider adapter, or writable management API. ADRs `0002`–`0004` keep task, event, and configuration contracts open.

The product needs to support diverse user-authored compositions: a single agent, multiple roles with a user-chosen division of work, parallel specialists, a hierarchy, a workflow, or another representation not yet specified. The exact representation must remain open. Hardcoding a three-layer role split would narrow the product and contradict the stated direction.

Trade-off: a topology-neutral design preserves user freedom, but it increases the future cost of profile validation, event identity, cancellation propagation, policy scoping, and deterministic tests. A built-in fixed topology would be simpler to demo but would make every other composition a second-class workaround. This trade-off is recorded here before the product direction is added to `docs/AI_HANDOFF.md`.

## Options

### A. Topology-neutral user-authored composition (recommended)

- A user-authored, versioned configuration describes the agent's composition and coordination. The runtime interprets the pinned revision and owns task state, events, policy, approvals, tool dispatch, and provider calls.
- No layer count, role name, hierarchy, delegation pattern, orchestration pattern, or example topology is encoded as a runtime default.
- A single-agent configuration and a multi-role configuration are both valid inputs in principle. Examples in documentation are non-normative fixtures, not product requirements.
- Capability grants, Skills, MCP connections, and policies remain separate, explicitly versioned inputs. A role does not acquire authority merely by being named or positioned in a composition.
- The exact profile schema, identity model, validation errors, cycle/concurrency semantics, delegation authority, cancellation propagation, sub-task identity, and public API remain undecided.

Consequences: maximum product flexibility and a clear security boundary; more design work before any public contract. Weaker coding models may overfit illustrative examples, so documentation and future tests must explicitly reject hardcoded layer counts and role names.

### B. Built-in layered role template

Implement a fixed three-layer hierarchy with predefined role responsibilities, or ship it as the default scaffold.

Consequences: easier first demo and simpler validation, but it turns one example into the product's shape. Rejected because it contradicts the user's product direction and would require later migration for users who want a single agent or a different composition.

### C. Prompt-only emergent roles

Let the model invent roles and coordination from a free-form prompt without a durable, validated composition document.

Consequences: low initial configuration cost, but no stable configuration revision, auditable role identity, deterministic policy scoping, cancellation ownership, or reproducible replay. Rejected because Conchbase must own execution and security rather than delegate them to model output.

## Recommendation

Accept only the **intent** of topology-neutral high customization. Keep the composition data model, profile schema, API shape, and validation rules as open proposals. Do not add task/config write routes, generated client types, Pagurus forms, hardcoded role constants, or built-in three-layer templates.

Pagurus may eventually edit user-authored compositions through the versioned Runtime API. It must not read or write Conchbase private files, define a second schema, or present one example topology as the only supported shape.

## Validation

The bounded deterministic executor is implemented and tested in ADR 0016. Future general-composition validation must include:

- a single-agent input and at least two distinct user-authored multi-role inputs, with no assertion that any layer count or role name is canonical;
- a validator that rejects malformed composition input without executing a model or tool;
- policy-gate, approval, and secret-redaction checks applied uniformly to every active node;
- configuration-revision pinning across a composition change;
- event ordering and cancellation reaching explicit terminal states across active nodes;
- dependency-free fixtures with no real credentials, personal data, or network calls.

See `docs/VALIDATION_PLAN.md` for current versus future coverage.
