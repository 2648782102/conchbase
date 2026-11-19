import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createBuiltinWriteTools } from '../src/runtime/write-tools.js';

test('creating a new file reports it as created', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'conchbase-write-'));
  try {
    const tools = createBuiltinWriteTools({ root });
    const result = await tools.invoke('workspace_write', { path: 'new.txt', content: 'hello' });
    assert.equal(result.ok, true);
    assert.equal(result.evidence?.facts.created, true);
    assert.equal(result.evidence?.facts.bytes, 5);
    assert.equal(readFileSync(path.join(root, 'new.txt'), 'utf8'), 'hello');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('overwriting an existing file requires explicit confirmation', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'conchbase-write-'));
  try {
    writeFileSync(path.join(root, 'existing.txt'), 'old content');
    const tools = createBuiltinWriteTools({ root });
    await assert.rejects(
      async () => { const r = tools.invoke('workspace_write', { path: 'existing.txt', content: 'new' }); if (r instanceof Promise) await r; },
      (cause: unknown) => (cause as { code?: string })?.code === 'overwrite_requires_confirmation',
    );
    assert.equal(readFileSync(path.join(root, 'existing.txt'), 'utf8'), 'old content', 'file is untouched');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('with overwrite: true the replacement succeeds and reports the old size', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'conchbase-write-'));
  try {
    writeFileSync(path.join(root, 'existing.txt'), 'old content');
    const tools = createBuiltinWriteTools({ root });
    const result = await tools.invoke('workspace_write', { path: 'existing.txt', content: 'new', overwrite: true });
    assert.equal(result.ok, true);
    assert.equal(result.evidence?.facts.created, false);
    assert.equal(result.evidence?.facts.previousBytes, 11);
    assert.equal(readFileSync(path.join(root, 'existing.txt'), 'utf8'), 'new');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('writes outside the workspace are still rejected', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'conchbase-write-'));
  try {
    const tools = createBuiltinWriteTools({ root });
    await assert.rejects(
      async () => { const r = tools.invoke('workspace_write', { path: '../escape.txt', content: 'x' }); if (r instanceof Promise) await r; },
      (cause: unknown) => (cause as { code?: string })?.code === 'path_escapes_root',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
