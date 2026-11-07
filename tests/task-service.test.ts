import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TaskService } from '../src/runtime/task-service.js';
import { SqliteTaskStore } from '../src/runtime/task-store.js';

function fixtureFetch(): typeof globalThis.fetch {
  return async () => new Response(JSON.stringify({
    choices: [{ message: { role: 'assistant', content: 'fake answer' } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function createService(filename: string): TaskService {
  const store = new SqliteTaskStore(filename);
  return new TaskService(store, {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture/model',
    fetch: fixtureFetch(),
  });
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
      'task.completed',
    ]);
    assert.ok(events.every((event) => event.taskId === task.id));
    assert.ok(events.every((event) => event.configurationRevisionId === task.configurationRevisionId));
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
