import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createBuiltinWriteTools } from '../src/runtime/write-tools.js';

/**
 * Delete, move, and copy are the operations that can lose work.
 *
 * The guards below are not ceremony: each one corresponds to a way a model can
 * erase or overwrite something by naming the wrong path once.
 */
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'conchbase-fileops-'));
  mkdirSync(path.join(root, 'sub'));
  writeFileSync(path.join(root, 'a.txt'), 'alpha');
  writeFileSync(path.join(root, 'sub', 'b.txt'), 'beta');
  return {
    root,
    tools: createBuiltinWriteTools({ root }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('the published workspace_write schema exposes overwrite', () => {
  const f = fixture();
  try {
    const writeTool = f.tools.list().find((tool) => tool.id === 'workspace_write');
    assert.ok(writeTool?.parameters, 'workspace_write must publish a parameter schema');
    assert.equal((writeTool!.parameters as {
      properties?: Record<string, { type?: string }>;
    }).properties?.overwrite?.type, 'boolean');
  } finally {
    f.cleanup();
  }
});

test('a file is deleted, and the evidence says what went', () => {
  const f = fixture();
  try {
    const result = f.tools.invoke('workspace_delete', { path: 'a.txt' }) as {
      ok: boolean; summary: string; evidence?: { facts: Record<string, unknown> };
    };
    assert.equal(result.ok, true);
    assert.equal(existsSync(path.join(f.root, 'a.txt')), false);
    assert.equal(result.evidence?.facts.kind, 'file');
  } finally {
    f.cleanup();
  }
});

test('a non-empty directory needs recursive: true', () => {
  const f = fixture();
  try {
    assert.throws(
      () => f.tools.invoke('workspace_delete', { path: 'sub' }),
      (cause: unknown) => (cause as { code?: string }).code === 'recursive_requires_confirmation',
    );
    assert.equal(existsSync(path.join(f.root, 'sub', 'b.txt')), true, 'nothing was removed');
    const result = f.tools.invoke('workspace_delete', { path: 'sub', recursive: true }) as { ok: boolean };
    assert.equal(result.ok, true);
    assert.equal(existsSync(path.join(f.root, 'sub')), false);
  } finally {
    f.cleanup();
  }
});

test('the workspace root itself can never be deleted', () => {
  const f = fixture();
  try {
    /*
     * Either refusal is correct; which one fires depends on how the root's own
     * path resolves (on macOS `.` under a symlinked tmpdir trips the boundary
     * check first). The property that matters is that the call fails and the
     * tree survives.
     */
    assert.throws(
      () => f.tools.invoke('workspace_delete', { path: '.', recursive: true }),
      (cause: unknown) => ['refuses_workspace_root', 'path_escapes_root']
        .includes(String((cause as { code?: string }).code)),
    );
    assert.equal(existsSync(path.join(f.root, 'a.txt')), true);
  } finally {
    f.cleanup();
  }
});

test('delete refuses paths outside the root', () => {
  const f = fixture();
  try {
    for (const attempt of ['../outside.txt', '/etc/passwd', 'sub/../../escape']) {
      assert.throws(
        () => f.tools.invoke('workspace_delete', { path: attempt }),
        (cause: unknown) => (cause as { code?: string }).code === 'path_escapes_root',
        `${attempt} must be refused`,
      );
    }
  } finally {
    f.cleanup();
  }
});

test('move renames within the root', () => {
  const f = fixture();
  try {
    const result = f.tools.invoke('workspace_move', { from: 'a.txt', to: 'sub/moved.txt' }) as { ok: boolean };
    assert.equal(result.ok, true);
    assert.equal(existsSync(path.join(f.root, 'a.txt')), false);
    assert.equal(readFileSync(path.join(f.root, 'sub', 'moved.txt'), 'utf8'), 'alpha');
  } finally {
    f.cleanup();
  }
});

test('move will not silently replace an existing destination', () => {
  const f = fixture();
  try {
    assert.throws(
      () => f.tools.invoke('workspace_move', { from: 'a.txt', to: 'sub/b.txt' }),
      (cause: unknown) => (cause as { code?: string }).code === 'target_exists',
    );
    assert.equal(readFileSync(path.join(f.root, 'sub', 'b.txt'), 'utf8'), 'beta', 'the destination is intact');
    assert.equal(readFileSync(path.join(f.root, 'a.txt'), 'utf8'), 'alpha', 'the source is intact');
  } finally {
    f.cleanup();
  }
});

test('copy duplicates a file and leaves the source', () => {
  const f = fixture();
  try {
    f.tools.invoke('workspace_copy', { from: 'a.txt', to: 'a-copy.txt' });
    assert.equal(readFileSync(path.join(f.root, 'a-copy.txt'), 'utf8'), 'alpha');
    assert.equal(readFileSync(path.join(f.root, 'a.txt'), 'utf8'), 'alpha');
  } finally {
    f.cleanup();
  }
});

test('copying a directory requires recursion', () => {
  const f = fixture();
  try {
    assert.throws(
      () => f.tools.invoke('workspace_copy', { from: 'sub', to: 'sub-copy' }),
      (cause: unknown) => (cause as { code?: string }).code === 'recursive_requires_confirmation',
    );
    f.tools.invoke('workspace_copy', { from: 'sub', to: 'sub-copy', recursive: true });
    assert.equal(readFileSync(path.join(f.root, 'sub-copy', 'b.txt'), 'utf8'), 'beta');
  } finally {
    f.cleanup();
  }
});

test('move and copy refuse to escape the root on either side', () => {
  const f = fixture();
  try {
    assert.throws(
      () => f.tools.invoke('workspace_move', { from: 'a.txt', to: '../out.txt' }),
      (cause: unknown) => (cause as { code?: string }).code === 'path_escapes_root',
    );
    assert.throws(
      () => f.tools.invoke('workspace_copy', { from: '../in.txt', to: 'x.txt' }),
      (cause: unknown) => (cause as { code?: string }).code === 'path_escapes_root',
    );
  } finally {
    f.cleanup();
  }
});

test('a missing source is reported, not treated as success', () => {
  const f = fixture();
  try {
    assert.throws(
      () => f.tools.invoke('workspace_move', { from: 'nope.txt', to: 'x.txt' }),
      (cause: unknown) => (cause as { code?: string }).code === 'not_found',
    );
    assert.deepEqual(readdirSync(f.root).sort(), ['a.txt', 'sub']);
  } finally {
    f.cleanup();
  }
});

test('every file operation is a write, so policy gates it', () => {
  const f = fixture();
  try {
    const ids = f.tools.list().map((definition) => [definition.id, definition.sideEffect]);
    assert.deepEqual(ids, [
      ['workspace_write', 'write'],
      ['workspace_delete', 'write'],
      ['workspace_move', 'write'],
      ['workspace_copy', 'write'],
    ]);
  } finally {
    f.cleanup();
  }
});
