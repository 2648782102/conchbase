import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type {
  ModelCatalogClient,
  ModelCatalogEntry,
} from '../src/runtime/model-catalog.js';
import { TaskService } from '../src/runtime/task-service.js';
import { DatabaseInstanceError, SqliteTaskStore } from '../src/runtime/task-store.js';

function fixtureFetch(): typeof globalThis.fetch {
  const frames = ['data: ', JSON.stringify({
    choices: [{ delta: { content: 'fake ' }, finish_reason: null }],
  }), '\n\ndata: ', JSON.stringify({
    choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }],
  }), '\n\ndata: [DONE]\n\n'].join('');
  return async () => new Response(frames, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

const modelCatalog: ModelCatalogClient = {
  async listModels(): Promise<readonly ModelCatalogEntry[]> {
    return Object.freeze([
      Object.freeze({ id: 'fixture/model', displayName: 'Fixture Model' }),
    ]);
  },
};

function createService(filename: string): TaskService {
  const store = new SqliteTaskStore(filename);
  return new TaskService(store, {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture/model',
    fetch: fixtureFetch(),
  }, modelCatalog);
}

test('a task completes with durable ordered events and pinned configuration', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-service-'));
  const filename = path.join(directory, 'runtime.sqlite');
  const service = createService(filename);

  try {
    const task = await service.createTaskAndWait({ prompt: 'hello' });
    assert.equal(task.state, 'succeeded');
    assert.equal(task.output, 'fake answer');
    assert.equal(task.error, null);
    assert.equal(task.attempt, 1);

    const events = service.store.listEvents(null);
    assert.deepEqual(events.map((event) => event.type), [
      'task.queued',
      'task.started',
      'task.output_delta',
      'task.output_delta',
      'task.completed',
    ]);
    assert.ok(events.every((event) => event.taskId === task.id));
    assert.ok(events.every((event) => event.configurationRevisionId === task.configurationRevisionId));
    assert.equal(task.partialOutput, null);
    const deltas = events.filter((event) => event.type === 'task.output_delta');
    assert.deepEqual(deltas.map((event) => event.data.delta), ['fake ', 'answer']);
    assert.deepEqual(deltas.map((event) => event.data.index), [0, 1]);
    assert.deepEqual(deltas.map((event) => event.data.outputLength), [5, 11]);
    assert.ok(deltas.every((event) => event.state === 'running'));
    assert.deepEqual(service.store.listEvents(events[0]!.id), events.slice(1));
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('restart interrupts unfinished work and explicit retry creates a new attempt', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-recovery-'));
  const filename = path.join(directory, 'runtime.sqlite');
  const first = createService(filename);
  let taskId = '';

  try {
    const task = first.store.createTask({
      id: 'task_pending',
      prompt: 'hello',
      model: 'fixture/model',
      configurationRevisionId: first.activeConfigurationRevisionId as never,
      attempt: 1,
    });
    taskId = task.id;
  } finally {
    first.close();
  }

  const second = createService(filename);
  try {
    const interrupted = second.store.getTask(taskId);
    assert.equal(interrupted?.state, 'interrupted');
    assert.match(interrupted?.error ?? '', /Runtime restarted/);
    assert.equal(interrupted?.partialOutput, null);
    assert.equal(second.store.listEvents(null).at(-1)?.type, 'task.interrupted');

    const retriedTask = second.retryTask(taskId);
    assert.equal(retriedTask.state, 'queued');
    assert.equal(retriedTask.attempt, 2);
    second.startTask(taskId);
    const finished = await second.waitForTask(taskId);
    assert.equal(finished.state, 'succeeded');
    assert.equal(finished.attempt, 2);
    assert.equal(finished.output, 'fake answer');
    assert.equal(second.store.listEvents(null).filter(
      (event) => event.taskId === taskId && event.type === 'task.interrupted',
    ).length, 1);
  } finally {
    second.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('one runtime database rejects a second simultaneous owner', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-instance-lock-'));
  const filename = path.join(directory, 'runtime.sqlite');
  const first = new SqliteTaskStore(filename);

  try {
    assert.throws(
      () => new SqliteTaskStore(filename),
      DatabaseInstanceError,
    );
  } finally {
    first.close();
  }

  const reopened = new SqliteTaskStore(filename);
  reopened.close();
  rmSync(directory, { recursive: true, force: true });
});

test('streamed progress is visible while active and cleared on cancellation', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-streaming-'));
  const filename = path.join(directory, 'runtime.sqlite');
  let unblock: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(new TextEncoder().encode(
        'data: ' + JSON.stringify({
          choices: [{ delta: { content: 'partial' }, finish_reason: null }],
        }) + '\n\n',
      ));
      await blocked;
      controller.close();
    },
  });
  const service = new TaskService(
    new SqliteTaskStore(filename),
    {
      magpieBaseUrl: 'http://127.0.0.1:3425',
      defaultModel: 'fixture/model',
      fetch: async () => new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    },
    modelCatalog,
  );

  try {
    const queued = service.createTask({ prompt: 'hello' });
    service.startTask(queued.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const active = service.store.getTask(queued.id);
    assert.equal(active?.state, 'running');
    assert.equal(active?.partialOutput, 'partial');
    assert.equal(
      service.store.listEvents(null).filter((event) => event.type === 'task.output_delta').length,
      1,
    );

    service.cancelTask(queued.id);
    unblock?.();
    const cancelled = await service.waitForTask(queued.id);
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.partialOutput, null);
    assert.equal(cancelled.output, null);
    assert.equal(
      service.store.listEvents(null).filter((event) => event.type === 'task.output_delta').length,
      1,
    );
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
