import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createGitReadTools } from '../src/runtime/git-tools.js';

/**
 * Push is the one tool whose effect is outside this machine and cannot be undone
 * there. Two properties matter: the destination cannot be chosen by the caller,
 * and an approval prompt can describe exactly what will leave.
 */
const ROOT = '/repo';

function fakeGit(
  responses: Readonly<Record<string, { code: number; stdout: string; stderr: string }>>,
  seen?: string[][],
) {
  return async (args: readonly string[]) => {
    seen?.push([...args]);
    const key = args.join(' ');
    for (const [pattern, response] of Object.entries(responses)) {
      if (key.includes(pattern)) return response;
    }
    return { code: 0, stdout: '', stderr: '' };
  };
}

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });

test('push sends the current branch to origin, never a caller-chosen target', async () => {
  const seen: string[][] = [];
  const tools = createGitReadTools({
    root: ROOT,
    gitBinary: '/usr/bin/git',
    run: fakeGit({
      'rev-parse --abbrev-ref HEAD': ok('main'),
      'remote get-url origin': ok('git@example.com:x/y.git'),
      'rev-list --count origin/main..HEAD': ok('2'),
      push: ok('pushed'),
    }, seen),
  });
  const result = await tools.invoke('git_push', {}) as { ok: boolean };
  assert.equal(result.ok, true);
  const push = seen.find((args) => args[0] === 'push');
  assert.deepEqual(push, ['push', 'origin', 'HEAD:refs/heads/main'],
    'the destination is fixed by the runtime');
});

test('a dry run reports what would go without pushing', async () => {
  const seen: string[][] = [];
  const tools = createGitReadTools({
    root: ROOT,
    gitBinary: '/usr/bin/git',
    run: fakeGit({
      'rev-parse --abbrev-ref HEAD': ok('main'),
      'remote get-url origin': ok('git@example.com:x/y.git'),
      'rev-list --count origin/main..HEAD': ok('3'),
    }, seen),
  });
  const result = await tools.invoke('git_push', { dryRun: true }) as { summary: string };
  assert.match(result.summary, /3 commit/);
  assert.equal(seen.some((args) => args[0] === 'push'), false, 'a dry run must not push');
});

test('a detached HEAD is refused instead of pushing somewhere arbitrary', async () => {
  const tools = createGitReadTools({
    root: ROOT,
    gitBinary: '/usr/bin/git',
    run: fakeGit({ 'rev-parse --abbrev-ref HEAD': ok('HEAD') }),
  });
  const result = await tools.invoke('git_push', {}) as { ok: boolean; errorCode?: string };
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'detached_head');
});

test('a repository without origin is refused', async () => {
  const tools = createGitReadTools({
    root: ROOT,
    gitBinary: '/usr/bin/git',
    run: fakeGit({
      'rev-parse --abbrev-ref HEAD': ok('main'),
      'remote get-url origin': { code: 2, stdout: '', stderr: 'no such remote' },
    }),
  });
  const result = await tools.invoke('git_push', {}) as { ok: boolean; errorCode?: string };
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'no_remote');
});

test('push is an external effect, so policy approves it at the standard level', () => {
  const tools = createGitReadTools({ root: ROOT, gitBinary: '/usr/bin/git', run: async () => ok() });
  const definition = tools.list().find((entry) => entry.id === 'git_push');
  assert.equal(definition?.sideEffect, 'external',
    'a local "write" would skip approval at the standard level, which is wrong for a push');
});

test('the push argument vector is fixed: no force, no extra flags', () => {
  const tools = createGitReadTools({ root: ROOT, gitBinary: '/usr/bin/git', run: async () => ok() });
  const definition = tools.list().find((entry) => entry.id === 'git_push');
  const schema = JSON.stringify(definition?.parameters ?? {});
  assert.equal(/force|branch|remote|--/.test(schema), false,
    'nothing in the schema can reach the git argv');
});

test('push with nothing ahead still reports cleanly', async () => {
  const tools = createGitReadTools({
    root: ROOT,
    gitBinary: '/usr/bin/git',
    run: fakeGit({
      'rev-parse --abbrev-ref HEAD': ok('main'),
      'remote get-url origin': ok('git@example.com:x/y.git'),
      'rev-list --count origin/main..HEAD': ok('0'),
    }),
  });
  const result = await tools.invoke('git_push', { dryRun: true }) as { summary: string };
  assert.match(result.summary, /nothing to push|up to date/);
});
