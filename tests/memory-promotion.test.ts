import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgentMemoryValidationError, SqliteAgentMemoryStore } from '../src/runtime/agent-memory.js';
import { BossMemory } from '../src/runtime/boss-memory.js';

function store(): { memory: SqliteAgentMemoryStore; cleanup: () => void } {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-promote-'));
  const db = new DatabaseSync(path.join(directory, 'runtime.sqlite'));
  const memory = new SqliteAgentMemoryStore(db);
  memory.initialize();
  return { memory, cleanup: () => { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

const snapshot = {
  projects: [{ id: 'p1', state: 'active' }],
  workers: [{ id: 'w1', state: 'idle', projectId: 'p1' }],
} as never;

test('validation rejects secret-like content, empty keys, and oversized bodies', () => {
  const { memory, cleanup } = store();
  try {
    assert.throws(() => memory.write({ scope: 'runtime', key: 'k', title: 'T', body: 'api_key=sk-live-abcdefghijklmnop', sourceIntentId: 'i' }), AgentMemoryValidationError);
    assert.throws(() => memory.write({ scope: 'runtime', key: '', title: 'T', body: 'b' }), AgentMemoryValidationError);
    assert.throws(() => memory.write({ scope: 'runtime', key: 'k', title: 'T', body: 'x'.repeat(5000) }), AgentMemoryValidationError);
  } finally {
    cleanup();
  }
});

test('a project or worker that does not exist is not promoted', async () => {
  const { memory, cleanup } = store();
  try {
    const boss = new BossMemory({ memory });
    await boss.recordProposals([
      { type: 'preference', scope: 'project', scopeId: 'missing-project', key: 'k', title: 'T', body: 'b' },
    ] as never, { userText: 'u', assistantReply: 'a', sourceIntentId: 'i', snapshot });
    assert.equal(memory.list({ scope: 'project', scopeId: 'missing-project' }).length, 0);
  } finally {
    cleanup();
  }
});

test('a global fact is dropped when no independent reviewer is configured', async () => {
  const { memory, cleanup } = store();
  try {
    const boss = new BossMemory({ memory });
    await boss.recordProposals([
      { type: 'preference', scope: 'runtime', key: 'k', title: 'likes concise', body: 'b' },
    ] as never, { userText: 'u', assistantReply: 'a', sourceIntentId: 'i', snapshot });
    assert.equal(memory.list({ scope: 'runtime' }).length, 0, 'no reviewer means no global write');
  } finally {
    cleanup();
  }
});

test('a reviewer rejection prevents the write', async () => {
  const { memory, cleanup } = store();
  try {
    const boss = new BossMemory({
      memory,
      reviewer: async () => ({ version: 1 as const, decisions: [{ index: 0, verdict: 'reject' as const, reason: 'not durable' }] }),
    });
    await boss.recordProposals([
      { type: 'preference', scope: 'runtime', key: 'k', title: 'x', body: 'b' },
    ] as never, { userText: 'u', assistantReply: 'a', sourceIntentId: 'i', snapshot });
    assert.equal(memory.list({ scope: 'runtime' }).length, 0);
  } finally {
    cleanup();
  }
});
