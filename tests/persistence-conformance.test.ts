import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { DatabaseInstanceError, SqliteTaskStore } from '../src/runtime/task-store.js';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

function withTemporaryDirectory(action: (directory: string) => void): void {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-persistence-'));
  try {
    action(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('a committed task and event survive an abrupt child-process exit', () => {
  withTemporaryDirectory((directory) => {
    const filename = path.join(directory, 'runtime.sqlite');
    const child = spawnSync(process.execPath, [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      [
        'const { SqliteTaskStore } = await import(new URL("./src/runtime/task-store.ts", import.meta.url).href);',
        'const store = new SqliteTaskStore(process.argv[1]);',
        'const configurationRevisionId = store.getConfigurationState().active.id;',
        'store.createTask({',
        '  id: "task_abrupt_exit",',
        '  prompt: "persistence fixture",',
        '  model: "fixture/model",',
        '  configurationRevisionId,',
        '  attempt: 1,',
        '});',
        'process.exit(0);',
      ].join('\n'),
      filename,
    ], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    assert.equal(child.status, 0, child.stderr);

    const store = new SqliteTaskStore(filename);
    try {
      const task = store.getTask('task_abrupt_exit');
      assert.equal(task?.state, 'queued');
      assert.equal(task?.prompt, 'persistence fixture');
      const events = store.listEvents(null);
      assert.deepEqual(events.map((event) => event.type), ['task.queued']);
      assert.equal(events[0]?.taskId, 'task_abrupt_exit');
      const configurationRevisionId = store.getConfigurationState().active.id;
      store.createTask({
        id: 'task_after_recovery',
        prompt: 'next task',
        model: 'fixture/model',
        configurationRevisionId,
        attempt: 1,
      });
      const replay = store.listEvents(events[0]?.id ?? null);
      assert.deepEqual(replay.map((event) => event.type), ['task.queued']);
      assert.equal(replay[0]?.taskId, 'task_after_recovery');
      assert.ok((replay[0]?.sequence ?? 0) > (events[0]?.sequence ?? 0));
    } finally {
      store.close();
    }
  });
});

test('the additive migration preserves legacy rows under one database owner', () => {
  withTemporaryDirectory((directory) => {
    const filename = path.join(directory, 'runtime.sqlite');
    const document = JSON.stringify({
      schemaVersion: 1,
      name: 'legacy config',
      skills: [],
      policies: [],
      mcpServers: [],
      plugins: [],
      secretRefs: [],
      metadata: {},
    });
    const legacy = new DatabaseSync(filename);
    try {
      legacy.exec(`
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
      legacy.prepare(`
        INSERT INTO configuration_revisions (id, document, applied_at, ordinal)
        VALUES ('cfg_000000000000000000000001', ?, '2026-11-12T00:00:00.000Z', 1)
      `).run(document);
      legacy.prepare('INSERT INTO configuration_state (singleton, revision_id) VALUES (1, ?)')
        .run('cfg_000000000000000000000001');
      legacy.prepare(`
        INSERT INTO tasks (
          id, prompt, model, configuration_revision_id, state, attempt, output, partial_output, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'task_legacy',
        'keep prompt',
        'legacy/model',
        'cfg_000000000000000000000001',
        'succeeded',
        2,
        'keep output',
        null,
        null,
      );
      legacy.prepare(`
        INSERT INTO events (
          sequence, id, task_id, type, state, configuration_revision_id, attempt, data
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        1,
        'evt_000000000001',
        'task_legacy',
        'task.completed',
        'succeeded',
        'cfg_000000000000000000000001',
        2,
        '{"keep":true}',
      );
      legacy.prepare(`
        INSERT INTO tool_requests (
          id, task_id, attempt, configuration_revision_id, composition_document_id, composition_node_id,
          tool_name, arguments_digest, idempotency_key, status, created_at, approval_id,
          approval_decision, approval_reason_digest, approval_decided_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'tqr_legacy',
        'task_legacy',
        2,
        'cfg_000000000000000000000001',
        'cmp_legacy',
        'node-a',
        'read_file',
        'arg_legacy',
        'idem_legacy',
        'pending',
        '2026-11-12T00:00:00.000Z',
        null,
        null,
        null,
        null,
      );
    } finally {
      legacy.close();
    }

    const store = new SqliteTaskStore(filename);
    try {
      assert.equal(store.getTask('task_legacy')?.output, 'keep output');
      assert.equal(store.getConfigurationState().active.id, 'cfg_000000000000000000000001');
      assert.equal(store.getToolRequest('tqr_legacy')?.id, 'tqr_legacy');
      assert.throws(() => new SqliteTaskStore(filename), DatabaseInstanceError);
    } finally {
      store.close();
    }

    const migrated = new DatabaseSync(filename);
    try {
      assert.equal(
        (migrated.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
        4,
      );
      const task = migrated.prepare('SELECT id, prompt, model, output FROM tasks').get() as Record<string, unknown>;
      assert.deepEqual({ ...task }, {
        id: 'task_legacy',
        prompt: 'keep prompt',
        model: 'legacy/model',
        output: 'keep output',
      });
      assert.equal(
        (migrated.prepare('SELECT COUNT(*) AS count FROM events').get() as { count: number }).count,
        1,
      );
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
        assert.equal(
          (migrated.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
          0,
        );
      }
    } finally {
      migrated.close();
    }

    const reopened = new SqliteTaskStore(filename);
    reopened.close();
  });
});
