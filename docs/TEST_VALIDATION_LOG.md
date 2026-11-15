# Test validation log

Target-mode record of the systematic test campaign. Each round states what was
measured, not just that it passed.

## Baseline (before this work)

- `npm test`: 400 tests, all passing, ~5.8s.
- No coverage measurement existed. `--experimental-test-coverage` alone failed to
  resolve TypeScript imports, so any attempt reported 100% over zero files.
- No layer separation; `npm test` was a single flat list of 79 file arguments.
- Seven runtime modules had no test that referenced them.

## Round 1 — build the system, then measure

Added:

- `scripts/test-suites.mjs` — 10 layers; fails on unassigned or missing files.
- `scripts/test-coverage.mjs` — `--import tsx` plus a real summary; gate at
  line 80 / branch 70 / function 80.
- `scripts/test-audit.mjs` — every runtime module is imported by a test or has a
  written exemption.
- `tests/tool-runtime.test.ts` — tool surface assembly (writes absent by default).
- `tests/secret-filter.test.ts` — credential detection, including false positives.

Findings:

- Coverage initially reported 92.47% line — but the report included `pagurus/`
  sources imported by the paired-runtime test. Excluding them raised the true
  figure to 95.56%. The first number was measuring two repositories.
- `tests/review-work-race.test.tsx` belongs to the Pagurus console and had never
  run here. It was removed from the suite and documented as an exclusion.
- `organization-contract-http`, `organization-public-contract`,
  `organization-store.sqlite`, `platform-store`, `work-store` are exercised
  indirectly; each exemption states which suite proves it.

Result: 408 tests passing, audit clean.

## Round 2 — close the CLI gap

Added `tests/cli.test.ts`, which runs the real CLI as a child process.

Findings:

- `cli.ts` had 47.9% line coverage and no test at all, making it the weakest
  module by a wide margin.
- Two initial assertions were wrong about the output shape (`bossSessionId` vs
  `bossSession.id`, and a task list that is an array not an object). They were
  corrected to assert the real contract rather than the assumed one.

Result: 414 tests passing.

## Round 3 — prove the suite can fail

Three deliberate defects were introduced, each in a distinct safety boundary:

| Injected defect | Detected by | Outcome |
| --- | --- | --- |
| Tombstone check disabled in the in-memory store | `tests/agent-memory.test.ts` | 1 failure |
| `containsSecretLike` always returns false | `tests/secret-filter.test.ts` | 3 failures |
| Runtime-scope confirmation check removed | `tests/memory-review.test.ts` | 1 failure |

Sources were restored and verified with `git status` and `rg` before continuing.
A suite that cannot fail is not evidence.

Result: 414 tests passing, coverage 95.69% line / 80.72% branch / 92.45% function.
