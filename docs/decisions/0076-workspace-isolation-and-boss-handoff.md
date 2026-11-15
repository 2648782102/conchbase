# Decision 0076: Explicit workspace root and honest Boss hand-off

Status: **accepted and implemented workspace isolation and hand-off fixes**

Date: 2026-11-15 (Asia/Shanghai).

## Context

A live end-to-end run asked the Boss Agent to build a real small open-source tool (`chaoslog`: a zero-dependency Node CLI that reports log-level distribution and per-hour error counts). Reaching a working result exposed five defects, one of them a genuine safety problem.

1. **Worker instructions rejected multi-line text.** `boundedString` rejected every C0 control character, including `\n`, so a worker could not receive a multi-line brief.
2. **Runtime-owned values were validated before being filled.** `expectedSequence`, `reportId`, `attentionId`, and digests were all supplied by the Runtime but checked before the fill ran, so a model omitting them failed an otherwise correct plan.
3. **Structural fields had no defaults.** A `create_agent` without `scope`, `capabilities`, or a report without `state` failed validation instead of receiving a sane default.
4. **`onAccepted` reported completion prematurely.** Agent Chat marked the Boss reply `replied` when actions were *accepted*, before hired workers finished, so the Boss said "done" while work was still running.
5. **Write tools were rooted at the process working directory.** During the live run a worker overwrote this repository's own `README.md` with `chaoslog`'s README. That is a real authority bug, not a test artefact.

## Decision

1. **Prose fields accept newlines.** `instructions` uses a dedicated bounded-prose validator: multi-line content is allowed, interior control characters are still rejected.
2. **All Runtime-owned values are filled before validation**: `expectedSequence`, `reportId`, `attentionId`, `intentId`, and every digest. A supplied value is replaced, because the Runtime is the authority for these facts.
3. **Structural fields have documented defaults**: `create_agent` gets `scope: ["project:<projectId>"]` and `capabilities: ["cap_read_context"]`; `report_worker` gets `state: "ready"`. Invalid capability tokens are dropped rather than failing the action.
4. **Acceptance is not completion.** The Agent Chat message stays `organizing` when a worker was dispatched, and only `submit` settling flips it to `replied` or `failed`.
5. **`CONCHBASE_WORKSPACE_ROOT` is required whenever `CONCHBASE_ALLOW_TOOL_WRITES=1`.** Writing into the process working directory can overwrite the Runtime's own repository, so the Runtime refuses to start without an explicit root. The default remains the working directory for read-only use.
6. **Task ids are unique.** The previous id was a deterministic hash of worker and event count, so dispatching the same worker twice could reuse an existing task.

## Options

### A. Keep writing relative to the process directory and rely on prompt discipline

Consequences: the demonstrated overwrite is one prompt away, and no prompt is a security boundary. Rejected.

### B. Validate every Runtime-owned field and reject on omission

Consequences: a model is punished for not knowing values only the Runtime can compute; this produced four separate live failures. Rejected.

### C. Fill first, validate after; require an explicit workspace root for writes

Consequences: plans that are structurally correct execute, and writes are confined to a directory the operator named. Accepted.

## Validation

- `tests/runtime-config.test.ts` asserts writes without `CONCHBASE_WORKSPACE_ROOT` are refused, and that a relative root is refused.
- `tests/organization-intent-parser.test.ts` covers sequence fill, id fill, and the SSE/JSON response paths.
- `tests/wire-conformance.test.ts` speaks OpenAI Chat Completions over a real socket and rejects any non-wire request body.
- Live result: the worker wrote `chaoslog.js` (5504 bytes) and `README.md` (3092 bytes) into `/tmp/chaoslog-workspace`, inside the configured root only.
- The produced CLI was executed against a fixture log and reported `ERROR 2 (33.3%)`, `INFO 2`, `WARN 1`, `DEBUG 1`, with one error in each of two hours — matching the fixture exactly.
- `npm run check`, `npm test` (326), and `npm run build` pass.

## Consequences

The Boss can delegate real work and report honestly about it. Writes are confined to a directory the operator names, and the Runtime refuses a configuration that would let a worker rewrite its own repository.

## Incident recorded

During the run a worker overwrote this repository's `README.md` with the generated project's README, because the write root was the process working directory. The file was restored from Git and the new `CONCHBASE_WORKSPACE_ROOT` requirement makes the same mistake impossible to reach by default.

The lesson: a tool grant without a scoped root is an authority bug, and it will surface as data loss the first time the model does exactly what it was asked.
MARKDOWN
head -3 docs/decisions/0076-workspace-isolation-and-boss-handoff.md
