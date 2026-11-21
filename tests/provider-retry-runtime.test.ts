import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TaskService } from '../src/runtime/task-service.js';
import { SqliteTaskStore } from '../src/runtime/task-store.js';
import type { ModelCatalogClient } from '../src/runtime/model-catalog.js';

const catalog: ModelCatalogClient = {
  async listModels() {
    return [{ id: 'fixture/chat-model', displayName: 'Fixture', supportsTools: false }];
  },
};

function sse(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`;
}

/**
 * A single 429 used to fail the whole task.
 *
 * The adapter classified it as retryable and nothing read that classification,
 * so the user saw "model failed" for a condition that resolves itself. This
 * asserts the run survives it *and* that the retry is visible rather than an
 * unexplained delay.
 */
test('a rate-limited turn is retried and the task still succeeds', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-retry-runtime-'));
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ error: { message: 'rate limit' } }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(sse('恢复后的回答'), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }) as typeof globalThis.fetch;

  const service = new TaskService(
    new SqliteTaskStore(path.join(directory, 'runtime.sqlite')),
    {
      magpieBaseUrl: 'http://127.0.0.1:3425',
      defaultModel: 'fixture/chat-model',
      fetch: fetchImpl,
    },
    catalog,
  );
  try {
    const task = service.createTask({ prompt: 'hi' });
    service.startTask(task.id);
    const finished = await service.waitForTask(task.id);

    assert.equal(finished.state, 'succeeded', `expected success: ${finished.error}`);
    assert.equal(finished.output, '恢复后的回答');
    assert.ok(calls >= 2, 'the provider had to be called again');
    const events = service.store.listTaskEvents(task.id).map((event) => event.type);
    assert.ok(events.includes('agent_loop.provider_retry'), `retry must be visible; events: ${events.join(',')}`);
    assert.ok(events.includes('agent_loop.provider_recovered'));
  } finally {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an auth failure is not retried and fails once', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-retry-auth-'));
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { message: 'bad key' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;

  const service = new TaskService(
    new SqliteTaskStore(path.join(directory, 'runtime.sqlite')),
    {
      magpieBaseUrl: 'http://127.0.0.1:3425',
      defaultModel: 'fixture/chat-model',
      fetch: fetchImpl,
    },
    catalog,
  );
  try {
    const task = service.createTask({ prompt: 'hi' });
    service.startTask(task.id);
    const finished = await service.waitForTask(task.id);
    assert.equal(finished.state, 'failed');
    assert.equal(calls, 1, 'an authentication failure is deterministic');
    const events = service.store.listTaskEvents(task.id).map((event) => event.type);
    assert.equal(events.includes('agent_loop.provider_retry'), false);
  } finally {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
