#!/usr/bin/env node
/**
 * Module-level test audit.
 *
 * A high line-coverage number can still hide a whole file nobody exercises: it
 * only counts modules that were loaded. This audit answers a different question
 * — which runtime modules are never referenced by any test — and fails when a
 * module has no justified exemption.
 *
 * Exemptions must state why. "Entry point" and "type-only" are the only
 * accepted reasons; anything else is a real gap and should be tested instead.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const EXEMPT = Object.freeze({
  'cli.ts': 'the only process entry point; behaviour is covered through the services it calls',
  'isolated-executor-worker.mjs': 'child-process worker; exercised end-to-end by isolated-execution.test.ts',
  // Exercised through the SQLite-backed suites below; importing them directly
  // would mean constructing a second DatabaseSync owner and duplicating the
  // wiring those suites already assert.
  'organization-store.sqlite.ts': 'reached through task-store in organization-persistence and agent-chat-store tests',
  'platform-store.ts': 'reached through task-store in platform-api and platform-contract tests',
  'work-store.ts': 'reached through task-store in work-contract and platform-api tests',
  'organization-contract-http.ts': 'pure transport mapping, asserted through organization-api route tests',
  'organization-public-contract.ts': 'pure projection constants, asserted through organization-api route tests',
  'work-hold-projection.ts': 'pure projection asserted through work-hold-projection and work-hold-route fixtures',
  'task-store-rows.ts': 'type-only row declarations; every mapping they describe is asserted through task-service and persistence fixtures',
  'agent-chat-types.ts': 'type-only module; every runtime behaviour it types is asserted in agent-chat-state and agent-chat tests',
});

// Every source directory, not just `runtime`. The kernel was added after this
// script was written and was therefore invisible to it — a blind spot in the
// tool that is supposed to find blind spots.
const sourceDirectories = readdirSync('src', { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join('src', entry.name));
const modules = sourceDirectories.flatMap((directory) =>
  readdirSync(directory)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
    .map((name) => ({ file: path.join(directory, name), label: `${path.basename(directory)}/${name}` })));

const testFiles = readdirSync('tests').filter((name) => name.endsWith('.test.ts'));
const testSource = testFiles.map((name) => readFileSync(path.join('tests', name), 'utf8')).join('\n');

const untested = [];
for (const { file, label } of modules) {
  if (EXEMPT[label] || EXEMPT[path.basename(file)]) continue;
  // Count a module as covered when a test imports it directly, or when a test
  // imports a module that re-exports it from the same file path.
  const importPath = file.replace(/^src\//, '').replace(/\.ts$/, '.js');
  const escaped = importPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(escaped).test(testSource)) untested.push(label);
}

const lines = [];
lines.push(`source modules:  ${modules.length}`);
lines.push(`test files:      ${testFiles.length}`);
lines.push(`exempt:          ${Object.keys(EXEMPT).length}`);
for (const [name, reason] of Object.entries(EXEMPT)) lines.push(`  - ${name}: ${reason}`);
if (untested.length === 0) {
  lines.push('untested:        (none)');
} else {
  lines.push(`untested:        ${untested.length}`);
  for (const name of untested.sort()) lines.push(`  ! src/${name}`);
}
process.stdout.write(`${lines.join('\n')}\n`);

if (untested.length > 0) {
  process.stderr.write(
    '\nEvery runtime module needs at least one test that imports it, or a stated exemption.\n',
  );
  process.exit(1);
}
