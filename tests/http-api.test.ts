import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/http/create-app.js';

test('read-only status routes return the documented API shapes', async () => {
  const app = createApp({ logger: false });

  try {
    const health = await app.inject({ method: 'GET', url: '/v1/health' });
    assert.equal(health.statusCode, 200);
    assert.deepEqual(health.json(), {
      status: 'ok',
      service: 'conchbase',
      apiVersion: 1,
    });

    const runtime = await app.inject({ method: 'GET', url: '/v1/runtime' });
    assert.equal(runtime.statusCode, 200);
    assert.deepEqual(runtime.json(), {
      name: 'Conchbase',
      version: '0.8.0',
      state: 'ready',
      capabilities: [],
    });

    const tasks = await app.inject({ method: 'GET', url: '/v1/tasks' });
    assert.equal(tasks.statusCode, 503);
  } finally {
    await app.close();
  }

  const configured = createApp({ logger: false, taskService: {} as never });
  try {
    const runtime = await configured.inject({ method: 'GET', url: '/v1/runtime' });
    assert.deepEqual(runtime.json<{ capabilities: string[] }>().capabilities, [
      'tasks',
      'events',
      'models',
      'streaming-output',
      'configuration-revisions',
      'composition-execution',
      'tool-approval-ledger',
      'provider-tool-call-observation',
      'agents',
      'provider-neutral-model-catalog',
    ]);
  } finally {
    await configured.close();
  }
});
