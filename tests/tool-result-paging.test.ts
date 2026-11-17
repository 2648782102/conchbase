import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createBuiltinReadTools } from '../src/runtime/tool-provider.js';
import { pageToolResult } from '../src/runtime/tool-result-paging.js';

test('a result inside the byte cap passes through untouched', () => {
  const paged = pageToolResult({ text: 'short', maxBytes: 100 });
  assert.equal(paged.summary, 'short');
  assert.equal(paged.truncated, false);
  assert.equal(paged.continuationArgument, null);
});

test('a truncated result states how to continue', () => {
  const paged = pageToolResult({
    text: 'x'.repeat(500),
    maxBytes: 100,
    continuation: { argument: 'offset', nextValue: 100, unit: 'byte' },
  });
  assert.equal(paged.truncated, true);
  assert.equal(paged.continuationArgument, 'offset');
  assert.equal(paged.continuationValue, 100);
  assert.match(paged.summary, /\[truncated:/);
  assert.match(paged.summary, /Continue with offset=100\./);
  assert.ok(paged.bytes <= 100, `summary must stay within the cap, got ${paged.bytes}`);
});

test('truncation without a continuation says so plainly', () => {
  const paged = pageToolResult({ text: 'y'.repeat(200), maxBytes: 40 });
  assert.equal(paged.truncated, true);
  assert.match(paged.summary, /\[truncated\]/);
  assert.equal(paged.continuationArgument, null);
});

test('multi-byte characters are never split into replacement characters', () => {
  const text = '中文内容'.repeat(50);
  const paged = pageToolResult({ text, maxBytes: 40 });
  assert.doesNotMatch(paged.summary, /\uFFFD/);
  assert.ok(paged.bytes <= 40);
});

test('workspace_read pages a large file with a usable offset', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'conchbase-paging-'));
  try {
    const body = Array.from({ length: 200 }, (_, index) => `line ${index}`).join('\n');
    writeFileSync(path.join(root, 'big.txt'), body);
    const tools = createBuiltinReadTools({ root, maxBytes: 200 });

    const first = await tools.invoke('workspace_read', { path: 'big.txt' });
    assert.match(first.summary, /Continue with offset=(\d+)\./);
    const offset = Number(/Continue with offset=(\d+)\./.exec(first.summary)![1]);
    assert.equal(offset, 200);

    const second = await tools.invoke('workspace_read', { path: 'big.txt', offset });
    assert.ok(second.summary.length > 0);
    assert.notEqual(second.summary, first.summary);

    const whole = await tools.invoke('workspace_read', { path: 'big.txt', maxBytes: 200, offset: 0 });
    assert.match(whole.summary, /line 0/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('workspace_read rejects an offset past the end of the file', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'conchbase-paging-oob-'));
  try {
    writeFileSync(path.join(root, 'small.txt'), 'tiny');
    const tools = createBuiltinReadTools({ root });
    await assert.rejects(
      async () => tools.invoke('workspace_read', { path: 'small.txt', offset: 999 }),
      /offset_out_of_range|Tool call/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('workspace_list reports more entries and honours the offset', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'conchbase-paging-list-'));
  try {
    for (let index = 0; index < 8; index += 1) {
      writeFileSync(path.join(root, `f${index}.txt`), 'x');
    }
    const tools = createBuiltinReadTools({ root });
    const first = await tools.invoke('workspace_list', { path: '.', limit: 3 });
    assert.match(first.summary, /more entries available\. Continue with offset=3\./);
    const next = await tools.invoke('workspace_list', { path: '.', limit: 3, offset: 3 });
    assert.notEqual(next.summary, first.summary);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('builtin tools publish their parameter schema to the model surface', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'conchbase-paging-schema-'));
  try {
    const tools = createBuiltinReadTools({ root });
    for (const tool of tools.list()) {
      assert.ok(tool.parameters, `${tool.id} must describe its parameters`);
      assert.equal(tool.parameters.type, 'object');
    }
    const read = tools.list().find((tool) => tool.id === 'workspace_read');
    assert.ok(read?.description.includes('offset'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('workspace_list stops at the requested page instead of reading the directory', async () => {
  // The listing used to read every entry and then slice, so the cost was the
  // directory size rather than the page size.
  const root = mkdtempSync(path.join(tmpdir(), 'conchbase-list-page-'));
  try {
    for (let index = 0; index < 25; index += 1) {
      writeFileSync(path.join(root, `file-${String(index).padStart(2, '0')}.txt`), 'x');
    }
    const tools = createBuiltinReadTools({ root });

    const first = await tools.invoke('workspace_list', { limit: 10 });
    assert.equal(first.summary.split('\n').filter((line) => line.includes('.txt')).length, 10);
    assert.match(first.summary, /more entries available\. Continue with offset=10\./);

    const middle = await tools.invoke('workspace_list', { offset: 20, limit: 10 });
    assert.equal(middle.summary.split('\n').filter((line) => line.includes('.txt')).length, 5);
    assert.doesNotMatch(middle.summary, /more entries available/);

    const past = await tools.invoke('workspace_list', { offset: 40, limit: 10 });
    assert.equal(past.summary.includes('.txt'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
