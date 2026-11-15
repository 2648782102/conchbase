# Decision 0086: Layered test system, coverage gate, and module audit

Status: **accepted and implemented**

Date: 2026-11-16 (Asia/Shanghai).

## Context

Before this change the repository had 400 passing tests and no way to say what they covered. Three specific problems made the green result weaker evidence than it looked:

1. **No coverage measurement.** Running `--experimental-test-coverage` without the TypeScript loader failed to resolve `./x.js` imports and then printed `all files 100.00`. A missing report looked like perfect coverage.
2. **No layer separation.** `npm test` was one flat list of 79 file arguments. A failure identified the suite, not the boundary that broke.
3. **No module accountability.** Seven runtime modules were never referenced by any test. Line coverage cannot reveal this, because it only counts modules that were loaded.

## Decision

1. **Ten ordered layers.** `scripts/test-suites.mjs` groups tests from pure domain rules up to dual-repository integration. The order is the diagnosis order; a lower-layer failure invalidates what follows. The script fails when a test file belongs to no layer or a layer names a file that does not exist.
2. **Coverage is measured with the loader.** `scripts/test-coverage.mjs` runs with `--import tsx` and fails when no summary is produced, so an unresolvable run can no longer masquerade as 100%.
3. **The paired console is excluded from coverage.** `agent-paired-runtime.test.ts` imports Pagurus sources to prove the published contract. Counting them measured two repositories at once and reported 92.5% instead of this repository's 95.6%. The exclusion is explicit and configurable.
4. **Thresholds are whole-runtime, not per-file.** Line 80 / branch 70 / function 80 by default. A per-file floor invites tests that execute a file without asserting anything; combined with the module audit it catches the real gaps.
5. **Every runtime module is accountable.** `scripts/test-audit.mjs` fails when a module has no test import and no stated exemption. Each exemption names the suite that proves the behaviour, so "exempt" means "proven elsewhere", not "untested".
6. **Failure injection validates the suite.** A green run is only evidence if the suite can go red. Three deliberate defects across distinct safety boundaries (memory tombstones, secret filtering, runtime-scope confirmation) were introduced and each was caught by the expected test.

## Options

### A. Keep the flat suite and add coverage only

Consequences: coverage would improve, but diagnosis would stay slow and an unassigned test could silently never run. Rejected.

### B. Require per-file coverage floors

Consequences: it pushes tests that touch a file rather than exercise it, and small legitimate modules become disproportionate work. Rejected in favour of whole-runtime floors plus module accountability.

### C. Count Pagurus coverage because the test imports it

Consequences: the number stops describing this repository and moves when the other repository changes. Rejected.

## Consequences

- `npm run verify` is the single gate: types, module audit, all tests, build.
- `npm run test:suite -- --suite <layer>` localises a failure before the full run.
- Coverage currently sits at 95.69% line / 80.72% branch / 92.45% function with 414 tests.
- The lowest remaining module is `cli.ts` at 47.9% line; it is covered through child-process tests, and the untested portion is mostly `serve` wiring that requires a live listener.
- A `.tsx` file that belonged to the Pagurus console was found in this repository and can never run here; it is now documented as an exclusion instead of being silently skipped.
