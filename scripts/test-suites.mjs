#!/usr/bin/env node
/**
 * Test layering for Conchbase.
 *
 * `npm test` runs every file in one flat process. That is fine for CI but poor
 * for diagnosis: a failure tells you the suite failed, not which layer broke.
 * This script groups the same files by the boundary they exercise and can run
 * one layer at a time.
 *
 * Usage:
 *   node scripts/test-suites.mjs --list
 *   node scripts/test-suites.mjs --suite domain
 *   node scripts/test-suites.mjs --all
 */
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const TESTS = path.join(process.cwd(), 'tests');

/**
 * Ordered from cheapest and most isolated to most integrated. A failure in a
 * lower layer invalidates everything above it, so the order is also the
 * diagnosis order.
 */
const SUITES = Object.freeze({
  domain: [
    'organization-contract.test.ts', 'organization-store.test.ts', 'organization-execution.test.ts',
    'organization-coordinator.test.ts', 'work-hold-projection.test.ts', 'work-hold-route.test.ts', 'organization-agent-projection.test.ts',
    'organization-action-contract.test.ts', 'organization-validators.test.ts', 'composition-document.test.ts',
    'configuration-document.test.ts', 'configuration-revision.test.ts',
    'composition-execution.test.ts', 'work-contract.test.ts', 'platform-contract.test.ts',
    'tool-request.test.ts', 'tool-capability.test.ts', 'agent-memory.test.ts', 'secret-filter.test.ts',
    'memory-types.test.ts', 'memory-promotion.test.ts', 'tool-request-preview.test.ts',
    'task-state-machine.test.ts',
    'kernel-policy.test.ts', 'kernel-process-spec.test.ts', 'kernel-level-integration.test.ts',
  ],
  'agent-loop': [
    'agent-loop.test.ts', 'agent-loop-tools.test.ts', 'agent-multi-tool.test.ts', 'agent-approval.test.ts',
    'read-reuse.test.ts', 'read-result-cache.test.ts', 'task-capabilities.test.ts', 'tool-result-paging.test.ts', 'execution-mode.test.ts', 'agent-scenario.test.ts',
    'policy-gate.test.ts', 'tool-gate.test.ts', 'task-runner.test.ts', 'task-lifecycle.test.ts', 'task-service.test.ts',
    'memory-review.test.ts', 'project-summary.test.ts', 'project-lifecycle.test.ts', 'project-export.test.ts',
    'task-race.test.ts', 'event-replay.test.ts', 'approval-preview-chat.test.ts',
    'tool-bounds.test.ts', 'tool-untrusted-output.test.ts', 'write-safety.test.ts',
    'no-arbitrary-shell.test.ts', 'capability-presets.test.ts',
    'worker-start-admission.test.ts', 'worker-slice-yield.test.ts',
    'side-effect-ledger.test.ts',
  ],
  providers: [
    'magpie-provider.test.ts', 'streaming-provider.test.ts', 'model-catalog.test.ts',
    'provider-conformance.test.ts', 'provider-tool-call.test.ts',
    'provider-message-wire-format.test.ts', 'wire-conformance.test.ts',
    'provider-observation-api.test.ts',
    'model-provider.test.ts', 'provider-registry.test.ts', 'fake-provider.test.ts',
    'error-categories.test.ts', 'provider-routing.test.ts',
  ],
  boss: [
    'organization-intent-parser.test.ts', 'boss-mode-service.test.ts',
    'boss-organization-context.test.ts', 'boss-mode-http.test.ts',
    'organization-convergence.test.ts', 'organization-convergence-runtime.test.ts',
    'organization-resume.test.ts', 'boss-memory-injection.test.ts',
    'boss-memory-write.test.ts', 'boss-memory.test.ts', 'organization-intent-input.test.ts', 'worker-outcome-report.test.ts',
  ],
  'agent-chat': [
    'agent-chat.test.ts', 'agent-chat-output.test.ts', 'boss-reply-formatting.test.ts', 'agent-chat-state.test.ts', 'agent-chat-projection.test.ts', 'agent-chat-history.test.ts', 'agent-chat-store.test.ts',
    'agent-chat-stream.test.ts', 'agent-chat-tools.test.ts', 'agent-done-idle.test.ts', 'primary-conversation.test.ts',
    'agent-chat-concurrent.test.ts', 'agent-chat-runtime-notice.test.ts',
  ],
  capabilities: [
    'mcp-provider.test.ts', 'skill-provider.test.ts', 'tool-runtime.test.ts', 'git-tools.test.ts', 'plugin-loader.test.ts', 'subprocess-plugin.test.ts', 'isolated-execution.test.ts',
    'controlled-execution.test.ts',
    'agent-capability-grants.test.ts',
    'git-commit.test.ts',
  ],
  api: [
    'http-api.test.ts', 'openapi-contract.test.ts', 'task-api.test.ts',
    'agent-api.test.ts', 'capability-audit.test.ts', 'configuration-api.test.ts', 'organization-api.test.ts',
    'platform-api.test.ts', 'tool-request-api.test.ts', 'memory-api.test.ts',
    'operations-api.test.ts', 'support-bundle.test.ts',
  ],
  persistence: [
    'persistence-conformance.test.ts', 'organization-persistence.test.ts',
    'agent-migration.test.ts', 'configuration-store.test.ts',
    'backup.test.ts', 'automatic-backup.test.ts',
  ],
  integration: [
    'worker-execution-restore.test.ts', 'organization-e2e.test.ts', 'agent-paired-runtime.test.ts',
    'task-store-migrations.test.ts',
  ],
  meta: [
    'repository-guardrails.test.ts', 'runtime-config.test.ts', 'global-work-scheduler.test.ts',
    'event-log.test.ts', 'ag-ui-events.test.ts', 'otel-genai.test.ts',
    'agent-name.test.ts', 'cli.test.ts', 'cli-serve.test.ts',
    'cli-status.test.ts', 'runtime-process.test.ts', 'diagnostics.test.ts',
    'node-version.test.ts',
  ],
});

const known = new Set(Object.values(SUITES).flat());
// `.tsx` files here belong to the Pagurus console and cannot run in this
// repository: they import vitest and `src/features/work/`, neither of which
// exists here. They are excluded rather than silently "passing".
const present = readdirSync(TESTS).filter((name) => name.endsWith('.test.ts'));
const unassigned = present.filter((name) => !known.has(name));
const missing = [...known].filter((name) => !present.includes(name));

const args = process.argv.slice(2);
if (args.includes('--list')) {
  for (const [suite, files] of Object.entries(SUITES)) {
    process.stdout.write(`${suite.padEnd(14)} ${String(files.length).padStart(2)} files\n`);
  }
  process.stdout.write(`\nunassigned: ${unassigned.length ? unassigned.join(', ') : '(none)'}\n`);
  process.stdout.write(`missing:    ${missing.length ? missing.join(', ') : '(none)'}\n`);
  process.exit(missing.length > 0 ? 1 : 0);
}

// A file that belongs to no suite would silently never run under --suite.
if (missing.length > 0) {
  process.stderr.write(`suite list references missing files: ${missing.join(', ')}\n`);
  process.exit(2);
}
if (unassigned.length > 0) {
  process.stderr.write(`untracked test files (add them to a suite): ${unassigned.join(', ')}\n`);
  process.exit(2);
}

function run(files, label) {
  process.stdout.write(`\n=== ${label} (${files.length} files) ===\n`);
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--test', ...files.map((file) => path.join('tests', file))],
    { stdio: 'inherit' },
  );
  return result.status ?? 1;
}

let exitCode = 0;
const target = args[args.indexOf('--suite') + 1];
if (args.includes('--suite') && !SUITES[target]) {
  process.stderr.write(`unknown suite '${target}'. Known: ${Object.keys(SUITES).join(', ')}\n`);
  process.exit(2);
}

const selected = args.includes('--all')
  ? Object.entries(SUITES)
  : Object.entries(SUITES).filter(([name]) => name === target);

for (const [name, files] of selected) {
  const status = run(files, name);
  if (status !== 0) {
    exitCode = status;
    break;
  }
}
process.exit(exitCode);
