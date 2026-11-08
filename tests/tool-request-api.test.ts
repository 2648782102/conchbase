import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/http/create-app.js';
import { parseConfigurationDocument } from '../src/runtime/configuration-document.js';
import { TaskService } from '../src/runtime/task-service.js';
import { SqliteTaskStore } from '../src/runtime/task-store.js';

const V2_DOCUMENT = parseConfigurationDocument({
  schemaVersion: 2,
  name: 'ledger api fixture',
  skills: [],
  policies: [],
  mcpServers: [],
  plugins: [],
  secretRefs: [],
  metadata: { fixture: 'ledger-api' },
  composition: {
    schemaVersion: 1,
    name: 'ledger api composition',
    nodes: [{ id: 'node-a', label: 'First node' }],
    links: [],
    entryNodeIds: ['node-a'],
    metadata: { shape: 'single' },
  },
});

test('tool request routes create, read, and decide without executing a tool', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-tool-api-'));
  const service = new TaskService(new SqliteTaskStore(path.join(directory, 'runtime.sqlite')), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture/model',
    fetch: async () => { throw new Error('HTTP ledger tests must not call a provider.'); },
  });
  const app = createApp({ logger: false, taskService: service });

  try {
    service.store.applyConfiguration(V2_DOCUMENT);
    const task = service.createTask({ prompt: 'ignored' });
    const body = {
      taskId: task.id,
      attempt: 1,
      compositionNodeId: 'node-a',
      toolCall: {
        toolName: 'fixture_read',
        arguments: { value: 'bounded' },
      },
    };

    const created = await app.inject({ method: 'POST', url: '/v1/tool-requests', payload: body });
    assert.equal(created.statusCode, 201);
    const requestId = created.json<{ request: { id: string } }>().request.id;
    assert.equal(created.json<{ created: boolean }>().created, true);

    const replay = await app.inject({ method: 'POST', url: '/v1/tool-requests', payload: body });
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json<{ created: boolean; request: { id: string } }>().request.id, requestId);

    const read = await app.inject({ method: 'GET', url: `/v1/tool-requests/${requestId}` });
    assert.equal(read.statusCode, 200);
    assert.equal(read.json<{ request: { status: string } }>().request.status, 'pending');

    const decided = await app.inject({
      method: 'POST',
      url: `/v1/tool-requests/${requestId}/approval`,
      payload: { decision: 'approved', reason: 'local fixture' },
    });
    assert.equal(decided.statusCode, 201);
    assert.equal(decided.json<{ changed: boolean; request: { status: string } }>().request.status, 'approved');

    const decisionReplay = await app.inject({
      method: 'POST',
      url: `/v1/tool-requests/${requestId}/approval`,
      payload: { decision: 'approved', reason: 'local fixture' },
    });
    assert.equal(decisionReplay.statusCode, 200);
    assert.equal(decisionReplay.json<{ changed: boolean }>().changed, false);

    const conflict = await app.inject({
      method: 'POST',
      url: `/v1/tool-requests/${requestId}/approval`,
      payload: { decision: 'rejected', reason: 'changed' },
    });
    assert.equal(conflict.statusCode, 409);

    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/tool-requests',
      payload: { ...body, toolCall: { toolName: 'fixture_read', arguments: { api_key: 'secret' } } },
    });
    assert.equal(invalid.statusCode, 400);
    assert.ok(Array.isArray(invalid.json<{ details: unknown[] }>().details));

    const missing = await app.inject({
      method: 'GET',
      url: '/v1/tool-requests/tqr_000000000000000000000000',
    });
    assert.equal(missing.statusCode, 404);

    const events = await app.inject({ method: 'GET', url: '/v1/events' });
    const types = events.json<{ events: { type: string }[] }>().events.map((event) => event.type);
    assert.deepEqual(types, [
      'task.queued',
      'tool.requested',
      'tool.approval_required',
      'tool.approved',
    ]);
    assert.equal(types.some((type) => type === 'tool.executed'), false);
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
    await app.close();
  }
});

test('tool request routes expose an explicit unavailable state without a service', async () => {
  const app = createApp({ logger: false });
  try {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/tool-requests',
      payload: { taskId: 'task_1', attempt: 1, compositionNodeId: 'node-a', toolCall: { toolName: 'fixture_read', arguments: {} } },
    });
    assert.equal(created.statusCode, 503);
    const read = await app.inject({
      method: 'GET',
      url: '/v1/tool-requests/tqr_000000000000000000000000',
    });
    assert.equal(read.statusCode, 503);
  } finally {
    await app.close();
  }
});
