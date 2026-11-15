#!/usr/bin/env node
/**
 * Coverage gate.
 *
 * Node's built-in coverage needs `--import tsx`: this project imports `./x.js`
 * for TypeScript sources, and without the loader the resolver fails before any
 * test runs.
 *
 * Thresholds are deliberately about the whole runtime rather than per file.
 * A per-file floor invites tests that execute a file without asserting
 * anything; whole-runtime floors plus the module audit catch the real gap.
 */
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const MIN_LINE = Number(process.env.CONCHBASE_COVERAGE_MIN_LINE ?? 80);
const MIN_BRANCH = Number(process.env.CONCHBASE_COVERAGE_MIN_BRANCH ?? 70);
const MIN_FUNC = Number(process.env.CONCHBASE_COVERAGE_MIN_FUNC ?? 80);

// Enumerate files explicitly: `--test tests/` does not resolve through the tsx
// loader in coverage mode, so the run fails before producing a report.
const files = readdirSync('tests')
  .filter((name) => name.endsWith('.test.ts'))
  .sort()
  .map((name) => path.join('tests', name));

// Exclude the paired console. `agent-paired-runtime.test.ts` dynamically imports
// Pagurus sources to prove the published contract works, but Pagurus is a
// separate repository with its own suite; counting it here would distort this
// repository's coverage in both directions.
const exclude = process.env.CONCHBASE_COVERAGE_EXCLUDE ?? 'pagurus/**';

const result = spawnSync(
  process.execPath,
  [
    '--import', 'tsx',
    '--experimental-test-coverage',
    `--test-coverage-exclude=${exclude}`,
    '--test', ...files,
  ],
  { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
);

process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');

const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
const totals = /all files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/.exec(output);
if (!totals) {
  process.stderr.write('coverage summary not found; the run did not produce a report\n');
  process.exit(1);
}
const [, line, branch, func] = totals.map(Number);
const failures = [];
if (line < MIN_LINE) failures.push(`line ${line}% < ${MIN_LINE}%`);
if (branch < MIN_BRANCH) failures.push(`branch ${branch}% < ${MIN_BRANCH}%`);
if (func < MIN_FUNC) failures.push(`func ${func}% < ${MIN_FUNC}%`);
if (failures.length > 0) {
  process.stderr.write(`\ncoverage gate failed: ${failures.join(', ')}\n`);
  process.exit(1);
}
if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
process.stdout.write(`\ncoverage gate passed: line ${line}%, branch ${branch}%, func ${func}%\n`);
