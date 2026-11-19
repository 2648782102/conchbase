import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createBuiltinReadTools } from '../src/runtime/tool-provider.js';

test('a very deep directory tree stops at the depth cap instead of recursing forever', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'conchbase-depth-'));
  try {
    let current = root;
    for (let i = 0; i < 20; i += 1) {
      current = path.join(current, `level${i}`);
      mkdirSync(current);
      writeFileSync(path.join(current, 'needle.txt'), 'needle');
    }
    const tools = createBuiltinReadTools({ root });
    const result = tools.invoke('text_search', { pattern: 'needle' });
    const settled = result instanceof Promise ? await result : result;
    assert.equal(settled.ok, true);
    assert.match(settled.summary, /depth/i, 'a depth notice must explain the cutoff');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reading a file truncates on a UTF-8 boundary, never mid-character', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'conchbase-utf8-'));
  try {
    // Multi-byte characters repeated so a fixed byte slice lands inside one.
    writeFileSync(path.join(root, 'cn.txt'), '中文内容'.repeat(200));
    const tools = createBuiltinReadTools({ root, maxBytes: 101 });
    const result = tools.invoke('workspace_read', { path: 'cn.txt', maxBytes: 101 });
    const settled = result instanceof Promise ? await result : result;
    assert.equal(settled.ok, true);
    assert.equal(settled.summary.includes('\uFFFD'), false, 'no replacement characters');
    assert.ok(Buffer.byteLength(settled.summary) <= 400, 'result stays bounded');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a directory with many entries reports pagination instead of dumping everything', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'conchbase-pages-'));
  try {
    for (let i = 0; i < 300; i += 1) writeFileSync(path.join(root, `file${String(i).padStart(3, '0')}.txt`), 'x');
    const tools = createBuiltinReadTools({ root });
    const result = tools.invoke('workspace_list', { path: '.', limit: 50 });
    const settled = result instanceof Promise ? await result : result;
    assert.equal(settled.ok, true);
    const listed = settled.summary.split('\n').filter((line) => line.trim().length > 0 && !line.startsWith('['));
    assert.ok(listed.length <= 60, `expected a bounded page, got ${listed.length} lines`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('path escapes are still rejected after the bounds are added', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'conchbase-escape-'));
  try {
    const tools = createBuiltinReadTools({ root });
    await assert.rejects(
      async () => { const r = tools.invoke('workspace_read', { path: '../../etc/passwd' }); if (r instanceof Promise) await r; },
      (cause: unknown) => (cause as { code?: string })?.code === 'path_escapes_root',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
