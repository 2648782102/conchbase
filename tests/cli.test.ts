import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.join(import.meta.dirname, '..');

/**
 * Runs the real CLI in a child process.
 *
 * `main()` is not exported and the CLI reads configuration at import time, so
 * the only honest way to test it is to execute it the way a user does. Each
 * case gets an isolated database so one command cannot affect the next.
 */
function cli(args: readonly string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/cli.ts', ...args],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        CONCHBASE_MAGPIE_URL: 'http://127.0.0.1:3425',
        ...env,
      },
      timeout: 60_000,
    },
  );
}

test('help prints usage and exits successfully', () => {
  for (const args of [['help'], ['--help']]) {
    const result = cli(args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:/);
    assert.match(result.stdout, /conchbase serve/);
    assert.match(result.stdout, /CONCHBASE_MAGPIE_URL/);
  }
});

test('an unknown command with no arguments falls back to usage', () => {
  // This is not an error path: it is how a bare invocation documents itself.
  const result = cli([]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:/);
});

test('organization and tasks read the persisted state', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-cli-'));
  const env = { CONCHBASE_DB: path.join(directory, 'runtime.sqlite') };
  try {
    const organization = cli(['organization'], env);
    assert.equal(organization.status, 0, organization.stderr);
    const snapshot = JSON.parse(organization.stdout) as {
      bossSession: { id: string; state: string };
      projects: unknown[];
      events: unknown[];
    };
    assert.match(snapshot.bossSession.id, /^boss_/);
    assert.equal(snapshot.bossSession.state, 'active');
    assert.deepEqual(snapshot.projects, []);
    assert.deepEqual(snapshot.events, []);

    const tasks = cli(['tasks'], env);
    assert.equal(tasks.status, 0, tasks.stderr);
    assert.deepEqual(JSON.parse(tasks.stdout), []);

    const events = cli(['events'], env);
    assert.equal(events.status, 0, events.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an invalid database path fails visibly instead of silently succeeding', () => {
  const result = cli(['tasks'], { CONCHBASE_DB: '/dev/null/nope.sqlite' });
  assert.notEqual(result.status, 0, 'a broken path must be an error, not an empty list');
});

test('run requires a model and says so', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-cli-run-'));
  try {
    const result = cli(['run', 'hello'], {
      CONCHBASE_DB: path.join(directory, 'runtime.sqlite'),
      CONCHBASE_MODEL: '',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CONCHBASE_MODEL|model/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('task with an unknown id exits non-zero', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-cli-task-'));
  try {
    const result = cli(['task', 'task_missing'], { CONCHBASE_DB: path.join(directory, 'runtime.sqlite') });
    assert.notEqual(result.status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
