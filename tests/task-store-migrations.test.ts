import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { migrateAgentSchema } from '../src/runtime/task-store-migrations.js';

/**
 * Schema migration.
 *
 * `migrateAgentSchema` runs *after* the store has created the base tables; it
 * upgrades an existing file rather than creating one from nothing. Two failure
 * modes matter and both are silent if untested: refusing a file it should
 * upgrade, and accepting a newer file it does not understand.
 */
const BASE_SCHEMA = `
  CREATE TABLE tasks (id TEXT PRIMARY KEY, prompt TEXT NOT NULL, model TEXT NOT NULL,
    configuration_revision_id TEXT NOT NULL, state TEXT NOT NULL, attempt INTEGER NOT NULL,
    output TEXT, partial_output TEXT, error TEXT) STRICT;
  CREATE TABLE events (sequence INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, task_id TEXT NOT NULL,
    type TEXT NOT NULL, state TEXT NOT NULL, configuration_revision_id TEXT NOT NULL,
    attempt INTEGER NOT NULL, data TEXT NOT NULL) STRICT;
`;
function file(): { db: DatabaseSync; cleanup: () => void } {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-migrations-'));
  const db = new DatabaseSync(path.join(directory, 'runtime.sqlite'));
  return {
    db,
    cleanup: () => {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('a database with the base schema receives the additive tables', () => {
  const { db, cleanup } = file();
  try {
    db.exec(BASE_SCHEMA);
    migrateAgentSchema(db);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
      .map((row) => row.name);
    // The base tables come from the store; this module adds the work tables and
    // the Agent columns on top of them. Anything else listed here would be a
    // claim the module does not actually make.
    assert.ok(tables.includes('work_triggers'), 'missing work_triggers');
  } finally {
    cleanup();
  }
});

test('migration is idempotent', () => {
  // Opening the same file twice must not throw or duplicate anything.
  const { db, cleanup } = file();
  try {
    db.exec(BASE_SCHEMA);
    migrateAgentSchema(db);
    assert.doesNotThrow(() => migrateAgentSchema(db));
  } finally {
    cleanup();
  }
});

test('a newer schema is refused rather than silently degraded', () => {
  const { db, cleanup } = file();
  try {
    db.exec('PRAGMA user_version = 99');
    assert.throws(() => migrateAgentSchema(db), /newer than this runtime supports/);
  } finally {
    cleanup();
  }
});

test('missing agent columns are added to an existing task table', () => {
  // This is the real upgrade path: a database created before Agent support.
  const { db, cleanup } = file();
  try {
    db.exec(BASE_SCHEMA);
    migrateAgentSchema(db);
    const columns = (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((row) => row.name);
    for (const column of ['agent_id', 'agent_revision_id', 'provider_id', 'model_id']) {
      assert.ok(columns.includes(column), `missing ${column}`);
    }
  } finally {
    cleanup();
  }
});

test('the event task index exists after migration', () => {
  const { db, cleanup } = file();
  try {
    db.exec(BASE_SCHEMA);
    migrateAgentSchema(db);
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[])
      .map((row) => row.name);
    assert.ok(indexes.includes('events_task_sequence'), 'task event lookup must stay indexed');
  } finally {
    cleanup();
  }
});

test('a fully opened store migrates an old file and can read/write it', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-migrations-open-'));
  const filename = path.join(directory, 'runtime.sqlite');
  try {
    // Build a pre-Agent database the way an older runtime would have left it.
    const legacy = new DatabaseSync(filename);
    legacy.exec(BASE_SCHEMA);
    legacy.exec(`
      INSERT INTO tasks (id, prompt, model, configuration_revision_id, state, attempt, output)
      VALUES ('task_legacy', 'old prompt', 'fixture/model', 'cfg_legacy', 'succeeded', 1, 'old output');
      INSERT INTO events (sequence, id, task_id, type, state, configuration_revision_id, attempt, data)
      VALUES (1, 'evt_000000000001', 'task_legacy', 'task.completed', 'succeeded', 'cfg_legacy', 1, '{}');
    `);
    legacy.close();

    // Opening through the real store must upgrade in place without losing rows.
    const { SqliteTaskStore } = await import('../src/runtime/task-store.js');
    const store = new SqliteTaskStore(filename);
    try {
      const migrated = store.getTask('task_legacy');
      assert.equal(migrated?.prompt, 'old prompt', 'legacy task survives migration');
      assert.equal(store.listEvents(null).length >= 1, true, 'legacy event survives migration');
      // New writes work after upgrade.
      const created = store.createTask({
        id: 'task_new', prompt: 'new', model: 'fixture/model',
        configurationRevisionId: migrated!.configurationRevisionId,
        attempt: 1,
      });
      assert.equal(created.prompt, 'new');
    } finally {
      store.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
