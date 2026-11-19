import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MEMORY_TYPES, SqliteAgentMemoryStore } from '../src/runtime/agent-memory.js';

function store(): { memory: SqliteAgentMemoryStore; cleanup: () => void } {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-mem-type-'));
  const db = new DatabaseSync(path.join(directory, 'runtime.sqlite'));
  const memory = new SqliteAgentMemoryStore(db);
  memory.initialize();
  return {
    memory,
    cleanup: () => { db.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

test('the supported memory types are exactly the product ones', () => {
  assert.deepEqual([...MEMORY_TYPES], ['preference', 'project-fact', 'instruction', 'decision', 'temporary']);
});

test('an entry records its type and defaults to preference', () => {
  const { memory, cleanup } = store();
  try {
    const typed = memory.write({ type: 'decision', scope: 'project', scopeId: 'p1', key: 'k1', title: 'T', body: 'chose Postgres', sourceIntentId: 'i1' });
    assert.equal(typed.type, 'decision');
    const dflt = memory.write({ scope: 'runtime', key: 'k2', title: 'T', body: 'likes terse replies', sourceIntentId: 'i2' });
    assert.equal(dflt.type, 'preference');
  } finally {
    cleanup();
  }
});

test('memory listing exposes the type for user review', () => {
  const { memory, cleanup } = store();
  try {
    memory.write({ type: 'project-fact', scope: 'project', scopeId: 'p1', key: 'k', title: 'Fact', body: 'uses SQLite', sourceIntentId: 'i' });
    const [entry] = memory.list({ scope: 'project', scopeId: 'p1' });
    assert.equal(entry?.type, 'project-fact');
    assert.equal(entry?.sourceIntentId, 'i', 'provenance stays visible');
  } finally {
    cleanup();
  }
});

test('a database created before the type column is upgraded in place', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-mem-legacy-'));
  const db = new DatabaseSync(path.join(directory, 'runtime.sqlite'));
  try {
    db.exec(`CREATE TABLE agent_memory (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, scope_id TEXT NOT NULL, key TEXT NOT NULL,
      title TEXT NOT NULL, body TEXT NOT NULL, source_intent_id TEXT NOT NULL DEFAULT '',
      reviewed_by TEXT NOT NULL DEFAULT 'unreviewed', created_at TEXT NOT NULL
    ) STRICT;`);
    db.exec(`INSERT INTO agent_memory (id, scope, scope_id, key, title, body, created_at)
      VALUES ('m1', 'runtime', '', 'k', 'old', 'old body', '2026-01-01')`);
    const memory = new SqliteAgentMemoryStore(db);
    memory.initialize();
    const [entry] = memory.list({ scope: 'runtime' });
    assert.equal(entry?.type, 'preference', 'legacy rows default to preference');
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the injected index respects a total character budget', async () => {
  const { MEMORY_PROMPT_BUDGET, renderMemoryIndex } = await import('../src/runtime/agent-memory.js');
  const many = Array.from({ length: 12 }, (_, i) => ({
    id: `m${i}`, type: 'preference' as const, scope: 'runtime' as const, scopeId: '',
    key: `k${i}`, title: 'x'.repeat(100), body: '', sourceIntentId: '', reviewedBy: 'accepted' as const,
    createdAt: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
  }));
  const rendered = renderMemoryIndex(many);
  assert.ok(rendered.length <= MEMORY_PROMPT_BUDGET, `index ${rendered.length} exceeds budget`);
  assert.ok(rendered.split('\n').length < 12, 'not every entry fits');
});

test('durable preferences are ranked ahead of temporary context', async () => {
  const { renderMemoryIndex } = await import('../src/runtime/agent-memory.js');
  const entries = [
    { id: 'a', type: 'temporary' as const, scope: 'runtime' as const, scopeId: '', key: 'k', title: 'TEMP', body: '', sourceIntentId: '', reviewedBy: 'accepted' as const, createdAt: '2026-02-01T00:00:00.000Z' },
    { id: 'b', type: 'preference' as const, scope: 'runtime' as const, scopeId: '', key: 'k', title: 'PREF', body: '', sourceIntentId: '', reviewedBy: 'accepted' as const, createdAt: '2026-01-01T00:00:00.000Z' },
  ];
  const lines = renderMemoryIndex(entries).trim().split('\n');
  assert.match(lines[0] ?? '', /PREF/, 'the durable preference comes first');
});
