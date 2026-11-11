# Decision 0028: Executable interface validation boundary

Status: **accepted repository development boundary; no public API contract changes**

Date: 2026-11-12 (Asia/Shanghai).

## Context

ADR 0026 closes the final local-first `1.0.0` target and marks interface validation as the next directly executable, non-public-contract slice. The repository already has deterministic provider and HTTP tests, but they are spread across feature-specific files and describe their assertions as implementation tests rather than a named, reproducible provider-compatibility fixture. The status file still lists `interface-validation` as `ready`, so a later coding model cannot tell from machine-readable state whether that slice has been closed.

The exact 47-path OpenAPI, work contract version 2, `user_version = 3`, process-scoped SecretHandles, and all accepted Runtime routes remain frozen. CI must not use real provider credentials, user data, or public-network calls. Pagurus needs a paired boundary for automated accessibility and published-contract fixtures.

## Options

### A. Treat the existing scattered tests as interface validation

Consequences: no new artifacts, but the `ready` slice stays open indefinitely and a later model cannot distinguish feature tests from a deliberately named compatibility fixture. Rejected.

### B. Connect CI to the locally configured Magpie gateway

Consequences: stronger live-provider evidence, but CI would depend on a machine-specific process, selected model, credentials, availability, rate limits, and provider output. Rejected.

### C. Add deterministic executable fixtures and record them as validation evidence

Consequences: explicit, repeatable provider-compatibility and contract checks using injected `fetch`, temporary local state, and no credentials. The slice closes without changing behavior or claiming real-provider conformance. Accepted.

## Decision

1. `tests/provider-conformance.test.ts` is an executable, credential-free compatibility fixture for the current OpenAI Chat Completions-compatible adapter. It runs one deterministic local HTTP server, exercises catalog, non-streaming, and streaming request shapes, normalized answer/tool-call observations, cancellations, HTTP errors, malformed frames, output limits, and provider-neutral catalog normalization. It uses loopback `127.0.0.1` and no real provider process.
2. Conchbase's `docs/PROJECT_STATUS.json` records `provider-conformance-fixture` in `validationEvidence` with `executableFixture: true`; `interface-validation` is removed from `nextBoundedSlices`. Persistence hardening remains an ADR-gated proposal.
3. Pagurus [ADR 0014](../../pagurus/docs/decisions/0014-interface-validation-boundary.md) accepts the paired executable accessibility and published-contract fixtures. Both repositories' status files, handoffs, validation plans, reading orders, and guardrails are updated in the same slice.
4. `v1.0.0` release notes, tags, and attached Release assets remain immutable. This ADR is a development boundary, not a product feature or new release.
5. No dependency, public route, schema, provider adapter, external Source, executor, generic secret resolver, browser storage rule, credential, user data, or machine-specific path is added or changed.

## Validation

- Conchbase: `npm run check`, `npm test`, and `npm run build`.
- Pagurus: `npm run check`, `npm test`, and `npm run build`.
- Guardrails assert the new ADRs, executable fixture entries, package test-script registration, and the absence of stale `ready` validation slices.
- The fixture makes no public-network call and does not read a user-selected model or credential.

## Consequences

The next coding model can identify interface validation as closed executable evidence from the status JSON rather than chat history. Real-provider conformance, automated browser-level accessibility with a real browser, production storage recovery, and remote pairing remain separate ADR-gated layers. The deterministic fixture is not a claim that every future provider transport is supported.

> Development boundary only: this ADR closes the repository's executable fixture slice; it does not accept a new provider, public API, release, or deferred product capability.
