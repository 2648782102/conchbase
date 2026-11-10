# Decision 0023: Secret handles and runtime-mediated use (proposal)

Status: **proposed, not accepted as a public contract**

Date: 2026-11-11 (Asia/Shanghai).

## Context

The user wants one place to add sensitive information such as keys. An Agent should refer to a value by key and use it without reading the plaintext. Conchbase currently keeps provider credentials behind the local Magpie adapter, and `schemaVersion: 1 | 2` configuration documents allow only opaque `secretRefs`. No secret store, resolver, installation, grant, or public secret route exists. Magpie is one adapter, not the product's credential model.

The phrase “AI can only use the value directly” cannot mean that a model receives an opaque handle and may invoke any tool with it. A model-controlled tool call could exfiltrate a resolved value to an arbitrary destination, encode it in an answer, or put it in an event. The runtime must own resolution and use; the model may receive only a bounded, non-secret handle and an explicit capability description.

This proposal records a product direction and threat model. It does not add an endpoint, schema version, configuration field, dependency, credential, encryption implementation, tool execution, or external write.

## Product direction

Conchbase will eventually own a **SecretHandle registry**: one runtime-local, encrypted-at-rest collection of named secret handles and metadata. Pagurus or another client may create, rotate, disable, and delete handles through a future authenticated Runtime API. It may show a handle's key, version, purpose, allowed destinations, grant, last-use time, and status; it must never show or receive the plaintext after creation. Creation is write-only from the browser's perspective: the value is submitted once to the runtime and never returned.

An Agent revision may contain bounded handle references and use descriptions, never secret values. A model sees only a stable placeholder such as `secret://github.token#v1` plus the capability that the runtime may perform with it. The runtime resolves the value inside a trusted adapter immediately before a constrained operation and never places plaintext in model context, prompts, task rows, durable events, logs, errors, client responses, Agent revisions, configuration documents, or tool-request arguments.

## Proposed boundary

### 1. Central secret ownership

- A handle has an immutable id, a versioned secret id, bounded purpose metadata, a fixed set of allowed adapters and destination binding fields, a status, and a grant revision. Rotation creates a new secret version and keeps the stable handle id.
- Encryption at rest uses an OS-managed key source or an explicitly accepted local key provider. The master key never enters the SQLite database, Git, browser storage, logs, or model context. No credential is committed or used as a test fixture.
- The registry is private runtime state. Pagurus does not read the database or a secret file and does not create a competing schema.
- Creation, rotation, disable, and deletion are separate from enabling an Agent and granting a tool. A configuration reference never installs or unlocks a secret.

### 2. Runtime-mediated use, not model-readable values

- The model may request an operation using a handle id. An untrusted tool call can never ask for `getValue`, `read`, `reveal`, `export`, or a raw secret argument.
- A trusted adapter receives a short-lived, in-memory resolution from a runtime-owned injector. It may inject the plaintext only into a fixed protocol field, such as one accepted HTTP header, for an allowlisted destination bound by the Mandate and capability grant.
- The adapter returns a normalized result containing status and bounded non-secret metadata. It redacts request bodies, responses, headers, errors, stack traces, and provider observations. It never returns the secret value or an equivalent reversible encoding.
- The runtime records a digest-only use receipt with handle id, secret version, grant revision, WorkItem/Assignment identity, adapter id, destination binding digest, and outcome. It does not record plaintext.
- Plaintext never crosses the Runtime API. A browser receives neither plaintext nor a decryptable token that a model could repurpose.

### 3. Capability and authorization

- A secret use requires all of: an active handle, a pinned Agent revision that names it, a runtime configuration revision, an accepted Mandate or grant revision, an allowlisted adapter, an exact operation, and a bound destination. Later source messages add context only; they do not broaden this grant.
- A Skill supplies instructions and cannot request or grant a secret. A ledger approval is an audit record, not permission to execute. Model output remains untrusted data.
- Per-use limits, cancellation, rate limits, and revocation are enforced by the runtime. Rotation invalidates in-flight resolutions and future assignments use the new version only under the pinned policy.
- Loopback-only operation has no API authentication today. A secret-management write API must wait for an accepted local authorization/pairing boundary; the current unauthenticated loopback API must not become an untrusted-process secret oracle.

### 4. Observability

- Pagurus direction: a write-only handle editor and a use-receipt view, never a value viewer. It shows missing, disabled, denied, rotated, and failed states without exposing secrets.
- Future events contain bounded scalar evidence: `secretHandleId`, `secretVersionDigest`, `grantRevisionId`, `adapterId`, `destinationDigest`, and a normalized outcome. No value, prefix, suffix, length that aids enumeration, provider envelope, or raw argument appears.
- Test fixtures use fake injectors and sentinel byte strings; deterministic assertions serialize all task state, events, client responses, and errors and prove the sentinel is absent.

## Options

### A. Put encrypted values in Agent definitions and decrypt for the model

Consequences: simple schema, but the model or any prompt/event/log path can observe plaintext. Rejected because it violates the user's core requirement and Conchbase's untrusted-model-output boundary.

### B. Give the model a handle and let any tool resolve it

Consequences: flexible tool use, but a prompt-injected model can redirect the resolved value to an arbitrary URL or tool argument. Rejected because arbitrary tool execution plus a resolver is an exfiltration primitive.

### C. Runtime-owned handles, fixed adapters, and bound destinations (recommended)

Consequences: less flexible than arbitrary secrets in arbitrary tools, but satisfies “use without reading” with a meaningful security boundary. A capability must explicitly declare where and how a secret may be injected. Accepted as the proposed direction only.

### D. Keep all credentials in external provider processes

Consequences: safest short-term implementation and current Magpie behavior, but does not provide the requested centralized user-managed registry or a reusable, provider-neutral secret contract. Keep as compatibility, not the final product direction.

## Open decisions before implementation

- Local authorization/pairing for secret writes; OS keychain/key-source selection; encryption, rotation, backup, export, and recovery semantics; and whether the first secret value is accepted through CLI, a paired local client, or both.
- Exact handle grammar, version id, digest algorithm, metadata bounds, destination binding format, adapter interface, revocation races, and redaction contract.
- Whether a fixed adapter is built into Conchbase or isolated as a child process; real executor isolation and crash-safe side effects remain separate accepted work.
- Public API, OpenAPI version, Pagurus ADR, event vocabulary, migration, and the relationship to [ADR 0022](0022-persistent-work-runtime-direction.md)'s Mandate and Assignment identity.
- A deterministic fake-injector acceptance suite that proves no plaintext reaches prompts, model adapters, durable events, task state, errors, logs, or client responses.

## Recommendation

Accept the **product intent**: one central, write-only secret registry; Agent-visible handle keys only; runtime-mediated, destination-bound injection; no plaintext read path for the model, UI, events, or logs. Keep the exact API, crypto, authorization, and adapter contracts as proposals. Implement no secret route or resolver until authentication/pairing capability, tool execution authorization, and redaction boundaries are accepted in separate ADRs.

For implementation sequencing, first accept the persistent-work domain and deterministic fake Sources from ADR 0022. Then build a fake SecretHandle injector with sentinel values and no external write. Only after its no-leak tests pass should an ADR decide a real local secret store, a fixed local adapter, and a paired Pagurus write-only editor.

## Validation

- Pure contract fixtures reject raw secret values, reveal operations, arbitrary destinations, unknown adapters, unbound URLs, mixed plaintext/handle arguments, and secret-like event fields.
- Adapter fixtures prove one injected value reaches only the declared protocol field of a fake destination; all returned state, events, errors, and logs omit the sentinel.
- Repository guardrails assert no real credential, machine-specific path, browser secret storage, model-visible plaintext route, or unapproved crypto dependency is introduced.
- Both repositories run `npm run check`, `npm test`, and `npm run build`; no public-network call, real credential, user runtime data, or external write is used.
