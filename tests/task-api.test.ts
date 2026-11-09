import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/http/create-app.js';
import { TaskService } from '../src/runtime/task-service.js';
import { SqliteTaskStore } from '../src/runtime/task-store.js';

function createFixtureService(filename: string): TaskService {
  return new TaskService(new SqliteTaskStore(filename), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture/model',
    fetch: async () => new Response(
      'data: ' + JSON.stringify({
        choices: [{ delta: { content: 'fake answer' }, finish_reason: 'stop' }],
      }) + '\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ),
  });
}

test('task, event, and model routes use one runtime service', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-api-'));
  const service = createFixtureService(path.join(directory, 'runtime.sqlite'));
  const app = createApp({ logger: false, taskService: service });

  try {
    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      payload: { prompt: '' },
    });
    assert.equal(invalid.statusCode, 400);

    const emptyJsonBody = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(emptyJsonBody.statusCode, 400);
    assert.deepEqual(emptyJsonBody.json(), {
      error: 'Request body does not match the API contract.',
    });

    const created = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      payload: { prompt: 'hello' },
    });
    assert.equal(created.statusCode, 202);
    const taskId = created.json<{ task: { id: string } }>().task.id;

    const finished = await service.waitForTask(taskId);
    assert.equal(finished.state, 'succeeded');

    const read = await app.inject({ method: 'GET', url: `/v1/tasks/${taskId}` });
    assert.equal(read.statusCode, 200);
    const taskBody = read.json<{
      task: { output: string; partialOutput: string | null };
    }>();
    assert.equal(taskBody.task.output, 'fake answer');
    assert.equal(taskBody.task.partialOutput, null);

    const events = await app.inject({ method: 'GET', url: '/v1/events' });
    assert.equal(events.statusCode, 200);
    const eventBody = events.json<{
      events: { id: string }[];
      cursor: string;
    }>();
    assert.equal(eventBody.events.length, 4);
    assert.equal(eventBody.cursor, eventBody.events.at(-1)?.id);

    const replay = await app.inject({
      method: 'GET',
      url: `/v1/events?after=${eventBody.events[0]!.id}`,
    });
    assert.equal(replay.json<{ events: unknown[] }>().events.length, 3);

    const unknownCursor = await app.inject({
      method: 'GET',
      url: '/v1/events?after=evt_000000999999',
    });
    assert.equal(unknownCursor.statusCode, 400);

    const retry = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/retry`,
    });
    assert.equal(retry.statusCode, 200);
    assert.equal(retry.json<{ retried: boolean }>().retried, true);
    await service.waitForTask(taskId);

    const models = await app.inject({ method: 'GET', url: '/v1/models' });
    assert.equal(models.statusCode, 502);
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
    await app.close();
  }
});
