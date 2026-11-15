import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  AgentMemoryValidationError,
  InMemoryAgentMemoryStore,
  MEMORY_LIMITS,
  SqliteAgentMemoryStore,
  parseAgentMemoryInput,
  renderMemoryIndex,
} from '../src/runtime/agent-memory.js';
import { DatabaseSync } from 'node:sqlite';

test('memory is scoped and runtime scope needs no target id', () => {
  const store = new InMemoryAgentMemoryStore();
  const entry = store.write({
    scope: 'runtime',
    key: 'style',
    title: '用户偏好简洁中文回答',
    body: '回答尽量短。',
  });
  assert.equal(entry.scopeId, '');
  assert.equal(store.list({ scope: 'runtime' }).length, 1);
  assert.equal(store.list({ scope: 'project', scopeId: 'project_alpha' }).length, 0);
});

test('a project memory cannot be read as a runtime memory', () => {
  // This is the failure that makes an assistant confidently wrong about the
  // wrong project: promoting a project fact into a global one.
  const store = new InMemoryAgentMemoryStore();
  store.write({ scope: 'project', scopeId: 'project_alpha', key: 'summary', title: 'A 项目结论', body: 'A 已完成。' });
  assert.equal(store.list({ scope: 'runtime' }).length, 0);
  assert.equal(store.list({ scope: 'project', scopeId: 'project_beta' }).length, 0);
  assert.equal(store.list({ scope: 'project', scopeId: 'project_alpha' }).length, 1);
});

test('writing the same key twice updates instead of duplicating', () => {
  const store = new InMemoryAgentMemoryStore();
  store.write({ scope: 'project', scopeId: 'p', key: 'summary', title: '旧', body: '旧正文' }, '2026-01-01T00:00:00.000Z');
  store.write({ scope: 'project', scopeId: 'p', key: 'summary', title: '新', body: '新正文' }, '2026-01-02T00:00:00.000Z');
  const entries = store.list({ scope: 'project', scopeId: 'p' });
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.title, '新');
});

test('memory rejects unknown scopes, missing target ids, secrets, and oversize text', () => {
  assert.throws(() => parseAgentMemoryInput({ scope: 'global', key: 'k', title: 't', body: 'b' }), AgentMemoryValidationError);
  assert.throws(() => parseAgentMemoryInput({ scope: 'project', key: 'k', title: 't', body: 'b' }), AgentMemoryValidationError);
  assert.throws(() => parseAgentMemoryInput({ scope: 'runtime', key: 'k', title: 't', body: 'token sk-abcdef' }), AgentMemoryValidationError);
  assert.throws(() => parseAgentMemoryInput({
    scope: 'runtime', key: 'k', title: 't', body: 'x'.repeat(MEMORY_LIMITS.body + 1),
  }), AgentMemoryValidationError);
  assert.throws(() => parseAgentMemoryInput({ scope: 'runtime', key: 'k', title: 't', body: 'b', extra: 1 }), AgentMemoryValidationError);
});

test('per-scope retention is bounded, newest kept', () => {
  const store = new InMemoryAgentMemoryStore();
  for (let index = 0; index < MEMORY_LIMITS.perScope + 5; index += 1) {
    const stamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
    store.write({ scope: 'runtime', key: `k${index}`, title: `条目 ${index}`, body: '正文' }, stamp);
  }
  const entries = store.list({ scope: 'runtime' });
  assert.equal(entries.length, MEMORY_LIMITS.perScope);
  assert.equal(entries[0]!.title, `条目 ${MEMORY_LIMITS.perScope + 4}`);
});

test('the injected index is bounded and contains titles only', () => {
  const store = new InMemoryAgentMemoryStore();
  for (let index = 0; index < MEMORY_LIMITS.injected + 5; index += 1) {
    const stamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
    store.write({ scope: 'runtime', key: `k${index}`, title: `标题 ${index}`, body: '这是不应进提示词的正文' }, stamp);
  }
  const rendered = renderMemoryIndex(store.list({ scope: 'runtime' }));
  assert.equal(rendered.split('\n').length, MEMORY_LIMITS.injected);
  assert.doesNotMatch(rendered, /不应进提示词/);
  assert.match(rendered, /\[全局\] 标题/);
});

test('entries can be removed by id', () => {
  const store = new InMemoryAgentMemoryStore();
  const entry = store.write({ scope: 'runtime', key: 'k', title: 't', body: 'b' });
  assert.equal(store.remove(entry.id), true);
  assert.equal(store.remove(entry.id), false);
  assert.equal(store.get(entry.id), null);
});

test('sqlite memory survives reopen and keeps one row per key', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-memory-'));
  const file = path.join(directory, 'memory.sqlite');
  try {
    const first = new DatabaseSync(file);
    const store = new SqliteAgentMemoryStore(first);
    store.initialize();
    store.write({ scope: 'project', scopeId: 'project_alpha', key: 'summary', title: '第一次', body: '正文一' });
    store.write({ scope: 'project', scopeId: 'project_alpha', key: 'summary', title: '第二次', body: '正文二' });
    first.close();

    const second = new DatabaseSync(file);
    const reopened = new SqliteAgentMemoryStore(second);
    reopened.initialize();
    const entries = reopened.list({ scope: 'project', scopeId: 'project_alpha' });
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.title, '第二次');
    assert.equal(reopened.remove(entries[0]!.id), true);
    assert.equal(reopened.list({ scope: 'project', scopeId: 'project_alpha' }).length, 0);
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a retracted key cannot be restored by an automatic write', () => {
  // Project convergence runs unattended. If it could restore a retracted fact,
  // deleting a memory would be undone by the next sweep.
  const store = new InMemoryAgentMemoryStore();
  const entry = store.write({
    scope: 'project', scopeId: 'p', key: 'summary', title: '旧', body: '旧正文', origin: 'automatic',
  });
  assert.equal(store.remove(entry.id), true);
  assert.equal(store.isRetracted('project', 'p', 'summary'), true);
  assert.throws(() => store.write({
    scope: 'project', scopeId: 'p', key: 'summary', title: '新', body: '新正文', origin: 'automatic',
  }), /retracted/i);
  assert.equal(store.list({ scope: 'project', scopeId: 'p' }).length, 0);
});

test('a conversational write may deliberately restore a retracted key', () => {
  const store = new InMemoryAgentMemoryStore();
  const entry = store.write({ scope: 'project', scopeId: 'p', key: 'k', title: 't', body: 'b', origin: 'automatic' });
  store.remove(entry.id);
  const restored = store.write({
    scope: 'project', scopeId: 'p', key: 'k', title: '再次要求', body: '正文', origin: 'conversational',
  });
  assert.equal(restored.title, '再次要求');
  assert.equal(store.isRetracted('project', 'p', 'k'), false);
});

test('sqlite tombstones survive reopen', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-tombstone-'));
  const file = path.join(directory, 'memory.sqlite');
  try {
    const first = new DatabaseSync(file);
    const store = new SqliteAgentMemoryStore(first);
    store.initialize();
    const entry = store.write({ scope: 'project', scopeId: 'p', key: 'k', title: 't', body: 'b' });
    store.remove(entry.id);
    first.close();

    const second = new DatabaseSync(file);
    const reopened = new SqliteAgentMemoryStore(second);
    reopened.initialize();
    assert.equal(reopened.isRetracted('project', 'p', 'k'), true);
    assert.throws(() => reopened.write({
      scope: 'project', scopeId: 'p', key: 'k', title: 't2', body: 'b2', origin: 'automatic',
    }), /retracted/i);
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
