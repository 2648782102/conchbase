import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SqliteTaskStore } from '../src/runtime/task-store.js';

test('Agent schema migration preserves legacy runtime rows and active configuration', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-agent-migration-'));
  const filename = path.join(directory, 'runtime.sqlite');
  const database = new DatabaseSync(filename);
  const document = JSON.stringify({
    schemaVersion: 1,
    name: 'legacy config',
    skills: [], policies: [], mcpServers: [], plugins: [], secretRefs: [], metadata: {},
  });

  try {
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, prompt TEXT NOT NULL, model TEXT NOT NULL,
        configuration_revision_id TEXT NOT NULL, state TEXT NOT NULL, attempt INTEGER NOT NULL,
        output TEXT, partial_output TEXT, error TEXT
      ) STRICT;
      CREATE TABLE events (
        sequence INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, task_id TEXT NOT NULL REFERENCES tasks(id),
        type TEXT NOT NULL, state TEXT NOT NULL, configuration_revision_id TEXT NOT NULL,
        attempt INTEGER NOT NULL, data TEXT NOT NULL
      ) STRICT;
      CREATE TABLE configuration_revisions (
        id TEXT PRIMARY KEY, document TEXT NOT NULL, applied_at TEXT NOT NULL, ordinal INTEGER NOT NULL UNIQUE
      ) STRICT;
      CREATE TABLE configuration_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        revision_id TEXT NOT NULL REFERENCES configuration_revisions(id)
      ) STRICT;
      CREATE TABLE tool_requests (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), attempt INTEGER NOT NULL,
        configuration_revision_id TEXT NOT NULL, composition_document_id TEXT NOT NULL,
        composition_node_id TEXT NOT NULL, tool_name TEXT NOT NULL, arguments_digest TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL, created_at TEXT NOT NULL,
        approval_id TEXT, approval_decision TEXT, approval_reason_digest TEXT, approval_decided_at TEXT
      ) STRICT;
    `);
    database.prepare(`
      INSERT INTO configuration_revisions (id, document, applied_at, ordinal) VALUES (?, ?, ?, 1)
    `).run('cfg_000000000000000000000001', document, '2025-01-01T00:00:00.000Z');
    database.prepare('INSERT INTO configuration_state (singleton, revision_id) VALUES (1, ?)')
      .run('cfg_000000000000000000000001');
    database.prepare(`
      INSERT INTO tasks (id, prompt, model, configuration_revision_id, state, attempt, output, partial_output, error)
      VALUES ('task_legacy', 'keep prompt', 'legacy/model', 'cfg_000000000000000000000001', 'succeeded', 2, 'keep output', NULL, NULL)
    `).run();
    database.prepare(`
      INSERT INTO events (sequence, id, task_id, type, state, configuration_revision_id, attempt, data)
      VALUES (1, 'evt_000000000001', 'task_legacy', 'task.completed', 'succeeded', 'cfg_000000000000000000000001', 2, '{"keep":true}')
    `).run();
    database.prepare(`
      INSERT INTO tool_requests (
        id, task_id, attempt, configuration_revision_id, composition_document_id, composition_node_id,
        tool_name, arguments_digest, idempotency_key, status, created_at, approval_id,
        approval_decision, approval_reason_digest, approval_decided_at
      ) VALUES ('tqr_legacy', 'task_legacy', 2, 'cfg_000000000000000000000001', 'cmp_legacy',
        'node-a', 'read_file', 'arg_legacy', 'idem_legacy', 'pending', '2025-01-01T00:00:00.000Z', NULL, NULL, NULL, NULL)
    `).run();
  } finally {
    database.close();
  }

  try {
    const store = new SqliteTaskStore(filename, { clock: () => '2026-11-09T00:00:00.000Z' });
    try {
      assert.deepEqual(store.getTask('task_legacy'), {
        id: 'task_legacy',
        prompt: 'keep prompt',
        model: 'legacy/model',
        configurationRevisionId: 'cfg_000000000000000000000001',
        state: 'succeeded',
        attempt: 2,
        output: 'keep output',
        partialOutput: null,
        error: null,
      });
      assert.deepEqual(store.listEvents(null).map((event) => ({
        id: event.id, taskId: event.taskId, type: event.type, state: event.state,
        configurationRevisionId: event.configurationRevisionId, attempt: event.attempt, data: event.data,
      })), [{
        id: 'evt_000000000001', taskId: 'task_legacy', type: 'task.completed', state: 'succeeded',
        configurationRevisionId: 'cfg_000000000000000000000001', attempt: 2, data: { keep: true },
      }]);
      assert.equal(store.getConfigurationState().active.id, 'cfg_000000000000000000000001');
      assert.equal(store.getToolRequest('tqr_legacy')?.id, 'tqr_legacy');
    } finally {
      store.close();
    }

    const migrated = new DatabaseSync(filename);
    try {
      assert.equal((migrated.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 4);
      for (const [table, expected] of [
        ['tasks', ['agent_id', 'agent_revision_id', 'provider_id', 'model_id']],
        ['events', ['agent_id', 'agent_revision_id', 'provider_id', 'model_id']],
      ] as const) {
        const columns = migrated.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
        assert.ok(expected.every((name) => columns.some((column) => column.name === name)));
      }
      const legacyTask = migrated.prepare('SELECT id, prompt, model, output FROM tasks').get() as Record<string, unknown>;
      assert.deepEqual({ ...legacyTask }, {
        id: 'task_legacy', prompt: 'keep prompt', model: 'legacy/model', output: 'keep output',
      });
      const legacyToolRequest = migrated.prepare('SELECT id, status, arguments_digest FROM tool_requests').get() as Record<string, unknown>;
      assert.deepEqual({ ...legacyToolRequest }, {
        id: 'tqr_legacy', status: 'pending', arguments_digest: 'arg_legacy',
      });
      assert.equal((migrated.prepare('SELECT COUNT(*) AS count FROM events').get() as { count: number }).count, 1);
      for (const table of [
        'work_triggers',
        'work_threads',
        'work_mandates',
        'work_items',
        'work_assignments',
        'work_outbox',
        'work_delivery_receipts',
        'work_events',
      ]) {
        assert.equal((migrated.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count, 0);
      }
    } finally {
      migrated.close();
    }

    const reopened = new SqliteTaskStore(filename);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
