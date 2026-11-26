import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/http/create-app.js';
import {
  indexWorkspaceFiles,
  WORKSPACE_INDEX_MAX_DEPTH,
  WORKSPACE_INDEX_MAX_ENTRIES,
  WORKSPACE_INDEX_MAX_FILE_BYTES,
} from '../src/runtime/workspace-index.js';

function fixture(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), 'conchbase-index-'));
  writeFileSync(path.join(root, 'README.md'), '# hello');
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'src', 'app.ts'), 'export const app = 1;');
  mkdirSync(path.join(root, 'node_modules'));
  writeFileSync(path.join(root, 'node_modules', 'dep.js'), 'ignored');
  mkdirSync(path.join(root, '.git'));
  writeFileSync(path.join(root, '.git', 'config'), 'ignored');
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('the index lists files with relative POSIX paths and skips build directories', () => {
  const f = fixture();
  try {
    const index = indexWorkspaceFiles(f.root);
    const paths = index.files.map((entry) => entry.path);
    assert.deepEqual(paths.sort(), ['README.md', 'src/app.ts']);
    assert.equal(index.files.find((entry) => entry.path === 'README.md')?.directory, '');
    assert.equal(index.files.find((entry) => entry.path === 'src/app.ts')?.directory, 'src');
  } finally {
    f.cleanup();
  }
});

test('the query filters by path, case-insensitively', () => {
  const f = fixture();
  try {
    assert.deepEqual(indexWorkspaceFiles(f.root, { query: 'APP' }).files.map((entry) => entry.path), ['src/app.ts']);
    assert.deepEqual(indexWorkspaceFiles(f.root, { query: 'nothing' }).files, []);
  } finally {
    f.cleanup();
  }
});

test('oversized files are not offered to a message', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'conchbase-index-'));
  try {
    writeFileSync(path.join(root, 'big.txt'), 'x'.repeat(WORKSPACE_INDEX_MAX_FILE_BYTES + 1));
    writeFileSync(path.join(root, 'small.txt'), 'x');
    assert.deepEqual(indexWorkspaceFiles(root).files.map((entry) => entry.path), ['small.txt']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the walk stops at the depth and entry budgets', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'conchbase-index-'));
  try {
    let current = root;
    for (let depth = 0; depth <= WORKSPACE_INDEX_MAX_DEPTH; depth += 1) {
      current = path.join(current, 'd');
      mkdirSync(current);
      writeFileSync(path.join(current, `f${depth}.txt`), 'x');
    }
    const deep = indexWorkspaceFiles(root, { limit: WORKSPACE_INDEX_MAX_ENTRIES });
    assert.equal(deep.files.some((entry) => entry.path.endsWith(`f${WORKSPACE_INDEX_MAX_DEPTH}.txt`)), false);
    assert.ok(deep.files.length <= WORKSPACE_INDEX_MAX_ENTRIES);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the route is absent without a workspace and bounded with one', async () => {
  const without = createApp({ logger: false });
  try {
    const response = await without.inject({ method: 'GET', url: '/v1/workspace/files' });
    assert.equal(response.statusCode, 404);
  } finally {
    await without.close();
  }

  const f = fixture();
  const app = createApp({
    logger: false,
    config: { workspaceRoot: f.root } as never,
  });
  try {
    const runtime = await app.inject({ method: 'GET', url: '/v1/runtime' });
    assert.ok(runtime.json<{ capabilities: string[] }>().capabilities.includes('workspace-index'));
    const response = await app.inject({ method: 'GET', url: '/v1/workspace/files?q=app&limit=5' });
    assert.equal(response.statusCode, 200);
    const body = response.json<{ files: { path: string }[]; truncated: boolean }>();
    assert.deepEqual(body.files.map((entry) => entry.path), ['src/app.ts']);
    assert.equal(body.truncated, false);
  } finally {
    await app.close();
    f.cleanup();
  }
});
