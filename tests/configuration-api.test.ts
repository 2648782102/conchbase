import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/http/create-app.js';
import { TaskService } from '../src/runtime/task-service.js';
import { SqliteTaskStore } from '../src/runtime/task-store.js';

function fixtureDocument(name: string) {
  return {
    schemaVersion: 1,
    name,
    skills: [],
    policies: [],
    mcpServers: [],
    plugins: [],
    secretRefs: [],
    metadata: { fixture: name },
  };
}

function createService(filename: string): TaskService {
  return new TaskService(new SqliteTaskStore(filename), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture/model',
  });
}

test('configuration routes validate, apply, roll back, and preserve task pinning', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-config-api-'));
  const service = createService(path.join(directory, 'runtime.sqlite'));
  const app = createApp({ logger: false, taskService: service });

  try {
    const initial = await app.inject({ method: 'GET', url: '/v1/configuration' });
    assert.equal(initial.statusCode, 200);
    const initialBody = initial.json<{ revision: { id: string; document: { name: string } } }>();
    const bootstrapId = initialBody.revision.id;
    assert.equal(initialBody.revision.document.name, 'phase-1-single-turn');

    const task = service.createTask({ prompt: 'hello', model: 'fixture/model' });
    assert.equal(task.configurationRevisionId, bootstrapId);

    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/configuration/validate',
      payload: { document: { schemaVersion: 2 } },
    });
    assert.equal(invalid.statusCode, 400);
    assert.ok(Array.isArray(invalid.json<{ details: unknown[] }>().details));

    const validated = await app.inject({
      method: 'POST',
      url: '/v1/configuration/validate',
      payload: { document: fixtureDocument('candidate') },
    });
    assert.equal(validated.statusCode, 200);
    assert.equal(validated.json<{ valid: boolean; document: { name: string } }>().document.name, 'candidate');

    const applied = await app.inject({
      method: 'POST',
      url: '/v1/configuration/apply',
      payload: { document: fixtureDocument('candidate') },
    });
    assert.equal(applied.statusCode, 200);
    const appliedBody = applied.json<{
      changed: boolean;
      activeRevisionId: string;
      revisions: { id: string }[];
    }>();
    assert.equal(appliedBody.changed, true);
    assert.notEqual(appliedBody.activeRevisionId, bootstrapId);
    assert.equal(appliedBody.revisions.length, 2);

    const afterApply = await app.inject({ method: 'GET', url: '/v1/tasks' });
    assert.equal(
      afterApply.json<{ activeConfigurationRevisionId: string }>().activeConfigurationRevisionId,
      appliedBody.activeRevisionId,
    );
    assert.equal(service.store.getTask(task.id)?.configurationRevisionId, bootstrapId);

    const readRevision = await app.inject({
      method: 'GET',
      url: `/v1/configuration/revisions/${bootstrapId}`,
    });
    assert.equal(readRevision.statusCode, 200);
    assert.equal(readRevision.json<{ revision: { id: string } }>().revision.id, bootstrapId);

    const unknown = await app.inject({
      method: 'GET',
      url: '/v1/configuration/revisions/cfg_000000000000000000000000',
    });
    assert.equal(unknown.statusCode, 404);

    const noOp = await app.inject({
      method: 'POST',
      url: '/v1/configuration/apply',
      payload: { document: fixtureDocument('candidate') },
    });
    assert.equal(noOp.json<{ changed: boolean }>().changed, false);

    const rollback = await app.inject({
      method: 'POST',
      url: '/v1/configuration/apply',
      payload: { rollbackTo: bootstrapId },
    });
    assert.equal(rollback.statusCode, 200);
    assert.equal(rollback.json<{ activeRevisionId: string }>().activeRevisionId, bootstrapId);

    const invalidRollback = await app.inject({
      method: 'POST',
      url: '/v1/configuration/apply',
      payload: { rollbackTo: 'cfg_000000000000000000000000' },
    });
    assert.equal(invalidRollback.statusCode, 404);

    const revisions = await app.inject({ method: 'GET', url: '/v1/configuration/revisions' });
    assert.equal(revisions.statusCode, 200);
    assert.equal(revisions.json<{ revisions: unknown[] }>().revisions.length, 2);

    const malformed = await app.inject({
      method: 'POST',
      url: '/v1/configuration/apply',
      payload: { document: {}, rollbackTo: bootstrapId },
    });
    assert.equal(malformed.statusCode, 400);

    const directDocument = await app.inject({
      method: 'POST',
      url: '/v1/configuration/apply',
      payload: fixtureDocument('direct'),
    });
    assert.equal(directDocument.statusCode, 400);
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
    await app.close();
  }
});

test('configuration routes expose an explicit unavailable state without a service', async () => {
  const app = createApp({ logger: false });
  try {
    for (const url of ['/v1/configuration', '/v1/configuration/revisions']) {
      const response = await app.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 503);
    }
    const apply = await app.inject({
      method: 'POST',
      url: '/v1/configuration/apply',
      payload: { document: fixtureDocument('offline') },
    });
    assert.equal(apply.statusCode, 503);
  } finally {
    await app.close();
  }
});
