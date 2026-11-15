# Test strategy

> Machine-readable status lives in `docs/PROJECT_STATUS.json`; this file explains how the suite is organised and what makes a run trustworthy.

## Layers

`npm run test:suite -- --list` prints the layers. They are ordered from cheapest and most isolated to most integrated, so a failure in a lower layer invalidates everything above it and the order is also the diagnosis order.

| Layer | What it proves |
| --- | --- |
| `domain` | Pure organisation, composition, work, tool-request, configuration and memory rules hold without any transport. |
| `agent-loop` | The runtime-owned loop, tool execution, approval, reuse, paging, budgets, memory review and project summaries behave correctly. |
| `providers` | The provider adapter speaks the real wire format, including a real socket conformance fixture. |
| `boss` | The Boss bridge: intent parsing, execution, convergence, resume, and memory proposals/injection. |
| `agent-chat` | Conversation state, durability across restart, streaming, tool projection, primary-conversation read model. |
| `capabilities` | MCP, Skills, isolated execution and controlled execution boundaries. |
| `api` | Every published HTTP contract, including exact path sets and error shapes. |
| `persistence` | Migration, single-owner locking, abrupt-exit recovery. |
| `integration` | Dual-repository live loopback acceptance with a fake provider. |
| `meta` | Repository guardrails, configuration, events, telemetry, naming, CLI. |

## Commands

```sh
npm test                    # every test file in one process (CI entry point)
npm run test:suite -- --list
npm run test:suite -- --suite boss
npm run test:suite -- --all
npm run test:coverage       # line/branch/function gate
npm run test:audit          # every runtime module is referenced by a test or explicitly exempt
npm run verify              # check + audit + test + build
```

## What makes a run trustworthy

1. **Coverage excludes the paired console.** `agent-paired-runtime.test.ts` imports Pagurus sources to prove the published contract works. Counting them here would distort this repository's numbers, so `--test-coverage-exclude=pagurus/**` is applied. Without it, measured line coverage was 92.5%; with it, 95.6%. The lower number was not this repository's coverage.
2. **Coverage needs the loader.** `--experimental-test-coverage` without `--import tsx` fails to resolve `./x.js` imports and reports 100% on zero files. The gate script fails loudly when no summary is produced rather than treating that as success.
3. **Every runtime module is referenced.** `test:audit` fails if a module has no test that imports it and no stated exemption. High line coverage can hide a whole file that simply was not loaded.
4. **Every test file belongs to a layer.** `test:suite` fails on unassigned or missing files. A test that exists but is never run is worse than no test, because it looks like coverage.
5. **Failure injection is part of the process.** A green run is only evidence if the suite can go red. See `docs/TEST_VALIDATION_LOG.md`.

## Known exclusions

- `tests/review-work-race.test.tsx` targets the Pagurus console (`vitest`, `src/features/work/`) and cannot run here. It is excluded rather than silently skipped.
- `main.ts` and `cli.ts` are process entry points. `cli.ts` is covered by child-process tests in `tests/cli.test.ts`; `main.ts` is exercised through the services it wires.
