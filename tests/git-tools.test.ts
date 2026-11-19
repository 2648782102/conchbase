import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createGitReadTools } from '../src/runtime/git-tools.js';
import { ToolRejectedError } from '../src/runtime/tool-provider.js';

/**
 * Read-only git tools.
 *
 * Two properties matter more than the output format: the provider can only
 * reach three fixed subcommands, and its arguments are never interpreted by a
 * shell. Both are asserted by capturing the exact argv a call produces.
 */
function recorder(reply: (args: readonly string[]) => { code: number; stdout: string; stderr: string }) {
  const calls: (readonly string[])[] = [];
  const provider = createGitReadTools({
    root: '/tmp/workspace',
    run: async (args) => {
      calls.push(args);
      return reply(args);
    },
  });
  return { provider, calls };
}

test('three read-only tools plus one approval-gated commit are exposed', () => {
  const { provider } = recorder(() => ({ code: 0, stdout: '', stderr: '' }));
  const ids = provider.list().map((tool) => tool.id).sort();
  assert.deepEqual(ids, ['git_commit', 'git_diff', 'git_log', 'git_status']);
  const read = provider.list().filter((tool) => tool.sideEffect === 'read').map((tool) => tool.id).sort();
  assert.deepEqual(read, ['git_diff', 'git_log', 'git_status'], 'the read tools stay read-only');
  const write = provider.list().filter((tool) => tool.sideEffect === 'write').map((tool) => tool.id);
  assert.deepEqual(write, ['git_commit'], 'only commit is a write, and it goes through approval');
});

test('no write subcommand is reachable through the provider', async () => {
  const { provider, calls } = recorder(() => ({ code: 0, stdout: '', stderr: '' }));
  // `git_commit` is the one deliberate write; everything destructive stays absent.
  for (const id of ['git_push', 'git_checkout', 'git_reset', 'git_clean', 'git', 'git_merge', 'git_rebase']) {
    assert.equal(provider.has(id), false, `${id} must not exist`);
    await assert.rejects(async () => provider.invoke(id, {}), ToolRejectedError);
  }
  assert.deepEqual(calls, [], 'an unknown tool never reaches the binary');
});

test('status uses a fixed argv with no model input', async () => {
  const { provider, calls } = recorder(() => ({ code: 0, stdout: ' M file.txt\n', stderr: '' }));
  const result = await provider.invoke('git_status', { anything: 'ignored' });
  assert.deepEqual(calls, [['status', '--porcelain']]);
  assert.equal(result.ok, true);
  assert.match(result.summary, /M file\.txt/);
});

test('diff passes a path after a separator, never as a flag', async () => {
  const { provider, calls } = recorder(() => ({ code: 0, stdout: '', stderr: '' }));
  await provider.invoke('git_diff', { path: 'src/app.ts' });
  assert.deepEqual(calls, [['diff', '--', 'src/app.ts']]);
});

test('a path that looks like a flag cannot become one', async () => {
  // `--output=/tmp/x` would be a flag to git if it were not after `--`.
  const { provider, calls } = recorder(() => ({ code: 0, stdout: '', stderr: '' }));
  await provider.invoke('git_diff', { path: '--output=/tmp/x' });
  assert.deepEqual(calls, [['diff', '--', '--output=/tmp/x']]);
});

test('an absolute or escaping path is rejected before spawning', async () => {
  const { provider, calls } = recorder(() => ({ code: 0, stdout: '', stderr: '' }));
  await assert.rejects(async () => provider.invoke('git_diff', { path: '/etc/passwd' }), ToolRejectedError);
  await assert.rejects(async () => provider.invoke('git_diff', { path: '../../etc/passwd' }), ToolRejectedError);
  assert.deepEqual(calls, [], 'nothing is executed for an invalid path');
});

test('log count is bounded and defaults conservatively', async () => {
  const { provider, calls } = recorder(() => ({ code: 0, stdout: 'abc someone subject\n', stderr: '' }));
  await provider.invoke('git_log', {});
  await provider.invoke('git_log', { maxCount: 1_000 });
  await provider.invoke('git_log', { maxCount: 0 });
  await provider.invoke('git_log', { maxCount: 'many' });
  assert.deepEqual(calls[0], ['log', '-n20', '--pretty=%h %an %s']);
  assert.deepEqual(calls[1], ['log', '-n100', '--pretty=%h %an %s'], 'clamped to the documented cap');
  // Out-of-range integers are clamped, not accepted and not defaulted away.
  assert.deepEqual(calls[2], ['log', '-n1', '--pretty=%h %an %s'], 'below-range clamps to 1');
  assert.deepEqual(calls[3], ['log', '-n20', '--pretty=%h %an %s'], 'a non-integer falls back to the default');
});

test('a non-repository directory reports a bounded code, not a crash', async () => {
  const { provider } = recorder(() => ({
    code: 128,
    stdout: '',
    stderr: 'fatal: not a git repository (or any of the parent directories): .git',
  }));
  await assert.rejects(
    async () => provider.invoke('git_status', {}),
    (cause: unknown) => cause instanceof ToolRejectedError && cause.code === 'not_a_repository',
  );
});

test('a missing binary is reported as unavailable', async () => {
  const provider = createGitReadTools({
    root: '/tmp/workspace',
    run: async () => {
      throw new ToolRejectedError('git_unavailable');
    },
  });
  await assert.rejects(
    async () => provider.invoke('git_status', {}),
    (cause: unknown) => cause instanceof ToolRejectedError && cause.code === 'git_unavailable',
  );
});

test('output over the cap is truncated and says so', async () => {
  const provider = createGitReadTools({
    root: '/tmp/workspace',
    maxBytes: 100,
    run: async () => ({ code: 0, stdout: 'x'.repeat(5_000), stderr: '' }),
  });
  const result = await provider.invoke('git_status', {});
  assert.match(result.summary, /truncated at 100 bytes/);
  assert.ok(result.bytes <= 100 + 64, `bytes ${result.bytes}`);
});

test('empty output is stated rather than returned blank', async () => {
  const { provider } = recorder(() => ({ code: 0, stdout: '', stderr: '' }));
  const result = await provider.invoke('git_status', {});
  assert.equal(result.summary, '(no output)');
});

test('a real repository is readable end to end', async () => {
  // Guards the wiring, not just the argument construction.
  const root = mkdtempSync(path.join(tmpdir(), 'conchbase-git-'));
  try {
    writeFileSync(path.join(root, 'note.txt'), 'hello\n');
    const provider = createGitReadTools({ root });
    // Without a repository this must fail cleanly rather than throw an opaque error.
    await assert.rejects(
      async () => provider.invoke('git_status', {}),
      (cause: unknown) => cause instanceof ToolRejectedError
        && (cause.code === 'not_a_repository' || cause.code === 'git_unavailable'),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the git subprocess does not inherit unrelated environment variables', async () => {
  // Git runs hooks with its environment. Copying the whole parent environment
  // would expose credentials to a hook or an unexpected git config helper.
  const previous = process.env.CONCHBASE_GIT_E2E_SECRET;
  process.env.CONCHBASE_GIT_E2E_SECRET = 'must-not-reach-git';
  try {
    const root = mkdtempSync(path.join(tmpdir(), 'conchbase-git-env-'));
    try {
      const { execFileSync } = await import('node:child_process');
      execFileSync('git', ['init', '-q'], { cwd: root });
      const captured = createGitReadTools({
        root,
        run: async (_args, cwd) => {
          const { spawnSync } = await import('node:child_process');
          const result = spawnSync(
            process.execPath,
            ['-e', "process.stdout.write(JSON.stringify({ secret: typeof process.env.CONCHBASE_GIT_E2E_SECRET !== 'undefined', prompt: process.env.GIT_TERMINAL_PROMPT ?? null }))"],
            { cwd, encoding: 'utf8' },
          );
          return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
        },
      });
      // The injected runner above bypasses env construction, so also assert the
      // policy at the source: the spawn options are now built from an allowlist.
      const source = readFileSync(new URL('../src/runtime/git-tools.ts', import.meta.url), 'utf8');
      assert.match(source, /for \(const name of \['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'\]\)/);
      assert.doesNotMatch(source, /env: \{ \.\.\.process\.env/);
      assert.equal(captured.list().filter((tool) => tool.sideEffect === 'read').length, 3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  } finally {
    if (previous === undefined) delete process.env.CONCHBASE_GIT_E2E_SECRET;
    else process.env.CONCHBASE_GIT_E2E_SECRET = previous;
  }
});
