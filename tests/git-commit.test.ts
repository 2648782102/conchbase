import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createGitReadTools } from '../src/runtime/git-tools.js';

function repo(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), 'conchbase-gitc-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('git_commit is a write tool and appears in the tool list', () => {
  const { root, cleanup } = repo();
  try {
    const provider = createGitReadTools({ root });
    const def = provider.list().find((tool) => tool.id === 'git_commit');
    assert.ok(def);
    assert.equal(def?.sideEffect, 'write', 'committing requires approval');
    assert.equal(provider.has('git_commit'), true);
  } finally {
    cleanup();
  }
});

test('committing with nothing staged is refused with a clear code', async () => {
  const { root, cleanup } = repo();
  try {
    const provider = createGitReadTools({ root });
    const result = await provider.invoke('git_commit', { message: 'empty' });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'nothing_staged');
  } finally {
    cleanup();
  }
});

test('a staged change is committed and reported with evidence', async () => {
  const { root, cleanup } = repo();
  try {
    writeFileSync(path.join(root, 'a.txt'), 'hello');
    execFileSync('git', ['add', 'a.txt'], { cwd: root });
    const provider = createGitReadTools({ root });
    const result = await provider.invoke('git_commit', { message: 'add a' });
    assert.equal(result.ok, true);
    assert.equal(result.evidence?.facts.message, 'add a');
    assert.equal(result.evidence?.facts.fileCount, 1);
    const log = await provider.invoke('git_log', { maxCount: 1 });
    assert.match(log.summary, /add a/);
  } finally {
    cleanup();
  }
});

test('no subcommand can be smuggled through the commit message', async () => {
  const { root, cleanup } = repo();
  try {
    writeFileSync(path.join(root, 'b.txt'), 'x');
    execFileSync('git', ['add', 'b.txt'], { cwd: root });
    const provider = createGitReadTools({ root });
    // A message that looks like a flag is passed as one argv entry after -m.
    const result = await provider.invoke('git_commit', { message: '--amend' });
    assert.equal(result.ok, true);
    const log = await provider.invoke('git_log', { maxCount: 1 });
    assert.match(log.summary, /--amend/, 'the message text is literal, not a flag');
  } finally {
    cleanup();
  }
});
