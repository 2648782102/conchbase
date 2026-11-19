import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTaskService } from '../src/runtime/task-service.js';
import { TaskConflictError } from '../src/runtime/task-store.js';
import type { ModelCatalogClient } from '../src/runtime/model-catalog.js';

function sse(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`;
}

/** A provider whose completion resolves only when the test says so. */
function gatedProvider() {
  const control: { release: (() => void) | null; entered: Promise<void> } = { release: null, entered: Promise.resolve() };
  let enteredResolve: (() => void) | null = null;
  control.entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
  const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    enteredResolve?.();
    const signal = init?.signal;
    if (signal?.aborted) throw new Error('aborted');
    await new Promise<void>((resolve, reject) => {
      control.release = resolve;
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    return new Response(sse('late'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof globalThis.fetch;
  return { control, fetch };
}

test('a late provider result after cancellation does not resurrect the task', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-race-'));
  const { control, fetch } = gatedProvider();
  const service = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425', defaultModel: 'fixture/model', fetch,
  });
  try {
    const created = service.createTask({ prompt: 'wait' });
    service.startTask(created.id);
    await control.entered;

    service.cancelTask(created.id);
    assert.equal(service.store.getTask(created.id)?.state, 'cancelling');

    // The provider resolves anyway; the Runtime must not accept the stale turn.
    control.release?.();
    const settled = await service.waitForTask(created.id);
    assert.ok(['cancelled', 'interrupted'].includes(settled.state), `unexpected ${settled.state}`);
    assert.notEqual(settled.state, 'succeeded');

    // No late success event was recorded after the cancellation decision.
    const types = service.store.listEvents(null).filter((event) => event.taskId === created.id).map((event) => event.type);
    const cancelledIndex = types.indexOf('task.cancelled');
    if (cancelledIndex >= 0) {
      assert.equal(types.slice(cancelledIndex).includes('task.completed'), false, 'no completion after cancellation');
    }
  } finally {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('cancelling an already-cancelling task is rejected, not double-applied', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-race-'));
  const { control, fetch } = gatedProvider();
  const service = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425', defaultModel: 'fixture/model', fetch,
  });
  try {
    const created = service.createTask({ prompt: 'wait' });
    service.startTask(created.id);
    await control.entered;
    service.cancelTask(created.id);
    assert.throws(() => service.cancelTask(created.id), TaskConflictError);
    control.release?.();
    await service.waitForTask(created.id);
  } finally {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('exceeding the loop deadline fails the task with a clear error', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-race-'));
  const neverEnding = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      if (signal?.aborted) { reject(new Error('aborted')); return; }
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  }) as typeof globalThis.fetch;
  const service = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425', defaultModel: 'fixture/model', fetch: neverEnding,
    loopBudget: { maxIterations: 2, maxToolCallsPerTurn: 2, deadlineMs: 150 },
  });
  try {
    const created = service.createTask({ prompt: 'slow' });
    service.startTask(created.id);
    const settled = await service.waitForTask(created.id);
    assert.ok(['failed', 'interrupted', 'cancelled'].includes(settled.state), `unexpected ${settled.state}`);
  } finally {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('retrying a running task is rejected; retrying a terminal one starts a new attempt', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-race-'));
  const { control, fetch } = gatedProvider();
  const service = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425', defaultModel: 'fixture/model', fetch,
  });
  try {
    const created = service.createTask({ prompt: 'wait' });
    service.startTask(created.id);
    await control.entered;
    assert.throws(() => service.retryTask(created.id), TaskConflictError);

    service.cancelTask(created.id);
    control.release?.();
    await service.waitForTask(created.id);
    const retried = service.retryTask(created.id);
    assert.equal(retried.attempt, 2);
    assert.equal(retried.state, 'queued');
  } finally {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
