import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  InMemoryAgentChatStore,
  SqliteAgentChatStore,
  migrateAgentChatSchema,
  type AgentChatConversationRecord,
} from '../src/runtime/agent-chat-store.js';
import { DatabaseSync } from 'node:sqlite';
import { SqliteTaskStore } from '../src/runtime/task-store.js';

function record(id = 'chat_fixture'): AgentChatConversationRecord {
  return Object.freeze({
    id,
    agentId: 'boss-agent',
    agentRevisionId: 'boss-runtime-v1',
    providerId: 'runtime',
    modelId: '组织编排',
    configurationRevisionId: 'cfg_fixture',
    isBoss: true,
    reasoningEffort: 'medium',
    createdAt: '2026-11-14T00:00:00.000Z',
    messages: Object.freeze([Object.freeze({
      id: 'amsg_fixture',
      sequence: 1,
      author: 'user' as const,
      body: '你好',
      state: 'published' as const,
      taskId: null,
      error: null,
      phase: 'accepted' as const,
      progress: null,
      updatedAt: '2026-11-14T00:00:00.000Z',
      replyToId: null,
      activity: Object.freeze([]),
    })]),
    idempotency: Object.freeze([['key-1', 'amsg_fixture'] as const]),
  });
}

test('in-memory agent chat store round-trips a conversation and idempotency keys', () => {
  const store = new InMemoryAgentChatStore();
  store.save(record());
  const loaded = store.get('chat_fixture');
  assert.equal(loaded?.agentId, 'boss-agent');
  assert.equal(loaded?.messages[0]?.body, '你好');
  assert.equal(loaded?.idempotency[0]?.[0], 'key-1');
});

test('SQLite agent chat store survives reopen and marks in-flight assistant messages failed', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-agent-chat-store-'));
  const filename = path.join(directory, 'runtime.sqlite');
  try {
    const first = new SqliteAgentChatStore(new DatabaseSync(filename));
    first.database.exec('PRAGMA user_version = 4;');
    migrateAgentChatSchema(first.database);
    first.initialize();
    first.save({
      ...record(),
      messages: Object.freeze([
        record().messages[0]!,
        Object.freeze({
          ...record().messages[0]!,
          id: 'amsg_assistant',
          sequence: 2,
          author: 'assistant' as const,
          body: '',
          state: 'organizing' as const,
          phase: 'organization' as const,
        }),
      ]),
    });
    first.database.close();
  } finally {
    // Keep the database for the reopen assertion.
  }
  try {
    const database = new DatabaseSync(filename);
    const second = new SqliteAgentChatStore(database);
    migrateAgentChatSchema(database);
    second.initialize();
    const loaded = second.get('chat_fixture');
    assert.equal(loaded?.messages.length, 2);
    assert.equal(loaded?.messages[1]?.state, 'failed');
    assert.match(loaded?.messages[1]?.error ?? '', /重启|restart/i);
    second.database.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('SQLite agent chat store recovers an interrupted organizing message on initialize', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-agent-chat-recover-'));
  const filename = path.join(directory, 'runtime.sqlite');
  try {
    const firstDatabase = new DatabaseSync(filename);
    firstDatabase.exec('PRAGMA user_version = 4;');
    migrateAgentChatSchema(firstDatabase);
    const first = new SqliteAgentChatStore(firstDatabase);
    first.initialize();
    first.save({
      ...record(),
      messages: Object.freeze([record().messages[0]!, Object.freeze({
        ...record().messages[0]!,
        id: 'amsg_interrupted',
        sequence: 2,
        author: 'assistant' as const,
        body: '我正在整理',
        state: 'organizing' as const,
        phase: 'organization' as const,
        progress: 40,
      })]),
    });
    firstDatabase.close();

    const secondDatabase = new DatabaseSync(filename);
    const second = new SqliteAgentChatStore(secondDatabase);
    second.initialize();
    const loaded = second.get('chat_fixture');
    assert.equal(loaded?.messages[1]?.state, 'failed');
    assert.equal(loaded?.messages[1]?.phase, 'terminal');
    assert.equal(loaded?.messages[1]?.progress, null);
    assert.match(loaded?.messages[1]?.error ?? '', /重启|restart/i);
    secondDatabase.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('SQLite agent chat store upserts messages without duplicating rows', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-agent-chat-upsert-'));
  const filename = path.join(directory, 'runtime.sqlite');
  try {
    const database = new DatabaseSync(filename);
    database.exec('PRAGMA user_version = 4;');
    migrateAgentChatSchema(database);
    const store = new SqliteAgentChatStore(database);
    store.initialize();
    const base = record();
    store.save(base);
    const updated = Object.freeze({
      ...base,
      messages: Object.freeze([
        Object.freeze({ ...base.messages[0]!, body: '更新后的内容' }),
        Object.freeze({
          ...base.messages[0]!,
          id: 'amsg_second',
          sequence: 2,
          author: 'assistant' as const,
          body: '新回复',
          state: 'replied' as const,
          phase: 'terminal' as const,
        }),
      ]),
    });
    store.save(updated);
    const loaded = store.get(base.id);
    assert.equal(loaded?.messages.length, 2);
    assert.equal(loaded?.messages[0]?.body, '更新后的内容');
    assert.equal(loaded?.messages[1]?.body, '新回复');
    const rows = database.prepare(
      'SELECT COUNT(*) AS count FROM agent_chat_messages WHERE conversation_id = ?',
    ).get(base.id) as { count: number };
    assert.equal(rows.count, 2);
    database.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('task event lookup uses a task_id index and returns only that task', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-task-events-'));
  try {
    const store = new SqliteTaskStore(path.join(directory, 'runtime.sqlite'));
    const agent = store.createAgent({
      name: '索引助手', instructions: 'X', providerId: 'magpie', modelId: 'fixture/model',
    });
    const task = store.createAgentTask({
      id: 'task_index_fixture',
      prompt: 'hello',
      agentId: agent.id,
      expectedAgentRevisionId: agent.currentRevisionId,
    });
    store.recordEvent(task.id, {
      taskId: task.id,
      type: 'agent_loop.turn_started',
      state: 'running',
      configurationRevisionId: task.configurationRevisionId,
      attempt: 1,
      data: { iteration: 0 },
    });
    store.close();
    const database = new DatabaseSync(path.join(directory, 'runtime.sqlite'));
    const plan = database.prepare(
      "EXPLAIN QUERY PLAN SELECT * FROM events WHERE task_id = ? ORDER BY sequence",
    ).all(task.id) as unknown as { detail: string }[];
    assert.ok(plan.some((row) => /events_task_sequence|USING INDEX/.test(row.detail)));
    database.close();
    const reopened = new SqliteTaskStore(path.join(directory, 'runtime.sqlite'));
    assert.ok(reopened.listTaskEvents(task.id).length >= 1);
    assert.equal(reopened.listTaskEvents('task_missing').length, 0);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
