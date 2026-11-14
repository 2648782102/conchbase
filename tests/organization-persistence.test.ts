import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseInstanceError, SqliteTaskStore } from '../src/runtime/task-store.js';
import { OrganizationConflictError } from '../src/runtime/organization-contract.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

function withTemporaryDirectory(action: (directory: string) => void): void {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-organization-'));
  try {
    action(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function createV3Database(filename: string): void {
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
  const database = new DatabaseSync(filename);
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
      PRAGMA user_version = 3;
    `);
    database.prepare('INSERT INTO configuration_revisions (id, document, applied_at, ordinal) VALUES (?, ?, ?, 1)')
      .run('cfg_000000000000000000000001', document, '2026-11-13T00:00:00.000Z');
    database.prepare('INSERT INTO configuration_state (singleton, revision_id) VALUES (1, ?)')
      .run('cfg_000000000000000000000001');
    database.prepare(`
      INSERT INTO tasks (id, prompt, model, configuration_revision_id, state, attempt, output, partial_output, error)
      VALUES ('task_legacy', 'keep prompt', 'legacy/model', 'cfg_000000000000000000000001', 'succeeded', 1, 'keep output', NULL, NULL)
    `).run();
  } finally {
    database.close();
  }
}

test('organization actions migrate from user_version 3 and replay after reopen', () => {
  withTemporaryDirectory((directory) => {
    const filename = path.join(directory, 'runtime.sqlite');
    createV3Database(filename);

    const store = new SqliteTaskStore(filename);
    try {
      store.organization.initialize('primary_conversation');
      assert.equal(store.organization.get().events.length, 0);
      store.organization.apply({
        type: 'open_project',
        expectedSequence: 0,
        projectId: 'project_alpha',
        originTriggerId: 'trigger_one',
      });
      store.organization.apply({
        type: 'activate_project',
        expectedSequence: 1,
        projectId: 'project_alpha',
      });
      assert.throws(
        () => store.organization.apply({
          type: 'activate_project',
          expectedSequence: 0,
          projectId: 'project_alpha',
        }),
        OrganizationConflictError,
      );
      assert.throws(() => new SqliteTaskStore(filename), DatabaseInstanceError);
      assert.equal(store.getTask('task_legacy')?.output, 'keep output');
    } finally {
      store.close();
    }

    const migrated = new DatabaseSync(filename);
    try {
      assert.equal(
        (migrated.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
        4,
      );
      assert.deepEqual(
        (migrated.prepare('SELECT sequence FROM organization_actions ORDER BY sequence').all() as unknown[]).map(
          (row) => ({ ...(row as Record<string, unknown>) }),
        ),
        [{ sequence: 1 }, { sequence: 2 }],
      );
      const persisted = migrated.prepare('SELECT action FROM organization_actions').all() as unknown as { action: string }[];
      assert.equal(persisted.some((row) => /sk-|Bearer|password|api[_-]?key/i.test(row.action)), false);
      assert.ok(persisted.every((row) => row.action.length <= 8192));
    } finally {
      migrated.close();
    }

    const reopened = new SqliteTaskStore(filename);
    try {
      const snapshot = reopened.organization.get();
      assert.equal(snapshot.events.length, 2);
      assert.equal(snapshot.projects[0]?.state, 'active');
      assert.deepEqual(snapshot.bossSession.projectIds, ['project_alpha']);
      assert.equal(reopened.organization.events(1).length, 1);
      assert.equal(reopened.getTask('task_legacy')?.output, 'keep output');
    } finally {
      reopened.close();
    }
  });
});

test('organization persistence keeps the published contract frozen', () => {
  const spec = readFileSync(path.join(repositoryRoot, 'docs/openapi.yaml'), 'utf8');
  assert.equal([...spec.matchAll(/^  (\/v1\/[^:]+):$/gm)].length, 87);
  assert.match(spec, /^  version: 1\.0\.0$/m);
  assert.match(spec, /\/v1\/organization\/session/);
});
