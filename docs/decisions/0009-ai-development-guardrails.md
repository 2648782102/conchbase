# Decision 0009: Executable AI development guardrails

Status: accepted for repository development guardrails, not a public API contract.

## Context

Conchbase is developed primarily by AI coding agents, and the repository explicitly does not optimize for human handoff. `docs/AI_TASK_QUEUE.md` currently blocks the next implementation slice until product direction is given on ADRs `0002`–`0008`. A weaker model continuing from the repository could otherwise fill the queue by inventing a write route, adding a provider SDK or SQLite driver, wiring internal runtime modules into HTTP, or describing planned capabilities as implemented.

`docs/REFERENCE_PROJECTS.md` records deterministic validators and machine-checkable artifacts as a reusable ecosystem pattern. The existing `npm test` suite checks runtime behavior and the current OpenAPI fixtures, but prose alone does not fail CI when an agent crosses a repository boundary. This ADR records a narrow, executable guardrail layer for that specific risk.

## Options

### A. Narrow repository guardrail tests in `npm test` (recommended)

- Add `tests/repository-guardrails.test.ts` to the existing Node test runner and CI path, with no new dependency.
- Check AI-first entry documents, ADR statuses, the read-only/loopback OpenAPI surface, source-boundary isolation, and the absence of premature provider/storage dependencies in `package.json` and `package-lock.json`.
- Treat the checks as canaries: when an ADR is accepted, update the guardrails in the same slice as the accepted decision instead of silently deleting them.

Consequences: a weaker model gets an immediate, deterministic failure before it can lock an unintended public contract. The checks are intentionally brittle about current facts and must evolve with accepted decisions. They do not validate runtime features that do not exist.

### B. Prose-only instructions

Keep all boundaries in `AGENTS.md`, `docs/AI_HANDOFF.md`, and the task queue.

Consequences: no new test code, but a model can still change the wrong file and receive a green CI run. Rejected because AI-first development needs machine feedback, not only instructions.

### C. Generated policy framework or custom linter service

Build a general repository-policy engine, schema parser, or external service.

Consequences: broader coverage in principle, but adds dependencies, configuration, and another source of truth before the product contracts exist. Rejected for this scaffold.

## Recommendation

Accept option A as a **development boundary only**. ADR `0009` does not accept any task, event, composition, provider, configuration, or persistence contract, and it does not authorize write routes, generated clients, provider SDKs, plugin loading, or a storage driver. ADRs `0002`–`0008` remain product-direction blocked.

The guardrails must stay small, dependency-free, and deterministic. They are not a general policy engine and are not evidence that Conchbase can run an agent task. Update them alongside an accepted ADR or a documented development-boundary change, never merely to make an unrelated change pass.

## Validation

`tests/repository-guardrails.test.ts` is part of `npm test`, which CI already runs. It uses only Node built-ins and local repository files; it performs no network calls and contains no credentials or personal data. One deterministic test feeds synthetic violations into the guardrail helpers to prove those checks fail, rather than silently becoming tautologies. It checks:

- required AI-first and product-invariant phrases in `AGENTS.md`;
- the implemented-versus-planned wording in `docs/AI_HANDOFF.md`, `README.md`, and `README.zh-CN.md`;
- proposal status for ADRs `0002`–`0008` and accepted statuses for ADRs `0001` and `0009`;
- exactly two read-only `/v1` paths, one loopback server URL, no write methods, and no request bodies in `docs/openapi.yaml`;
- no internal runtime imports or private-file I/O in `src/http/`, no Fastify/HTTP imports in `src/runtime/`, and no premature provider or storage imports anywhere in `src/` or `tests/`;
- no premature provider or storage package in `package.json` or `package-lock.json`.

See `docs/VALIDATION_PLAN.md` for current automated coverage and future validation layers.
