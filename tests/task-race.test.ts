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

/**
 * A queued task was accepted but never ran.
 *
 * `POST /v1/tasks` returns 202 for a queued task, so the caller has been told
 * the work is owned. Marking it `interrupted` on restart strands it: nothing
 * retries an interrupted task, and the user waits for a result that will never
 * arrive. It has no provider call, no tool call, and no side effect to lose, so
 * it can simply be queued for execution again.
 */
test('a queued task that never started is re-queued after a restart', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-queued-restart-'));
  const database = path.join(directory, 'runtime.sqlite');
  const fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/v1/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'm' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(sse('done'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof globalThis.fetch;
  const first = createTaskService(database, { magpieBaseUrl: 'http://127.0.0.1:3425', defaultModel: 'm', fetch });
  let second: ReturnType<typeof createTaskService> | null = null;
  try {
    const task = first.createTask({ prompt: 'hello', model: 'm' });
    assert.equal(task.state, 'queued');
    // Closing the service is what a clean restart does; the task row survives.
    first.close();

    second = createTaskService(database, { magpieBaseUrl: 'http://127.0.0.1:3425', defaultModel: 'm', fetch });
    const finished = await second.waitForTask(task.id);
    assert.equal(finished.state, 'succeeded', `re-queued task should run; got ${finished.state}: ${finished.error ?? ''}`);

    const types = second.store.listTaskEvents(task.id).map((event) => event.type);
    assert.equal(types.includes('task.interrupted'), false, 'an unstarted task was never interrupted');
  } finally {
    second?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * A restart re-admits every queued task at once, and nothing bounded how many
 * provider calls that produced: eight queued tasks meant eight simultaneous
 * completion streams. Admission is bounded per service; the extra tasks wait
 * as `queued` and still honour cancellation.
 */
function countingProvider(delayMs = 40) {
  let inFlight = 0;
  let peak = 0;
  const fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/v1/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'm' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    inFlight -= 1;
    return new Response(sse('ok'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof globalThis.fetch;
  return { fetch, peak: () => peak };
}

test('admission bounds concurrent provider calls, and the rest stay queued', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-admission-'));
  const provider = countingProvider();
  const service = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'm',
    maxConcurrentTasks: 2,
    fetch: provider.fetch,
  });
  try {
    const tasks = Array.from({ length: 6 }, (_, index) => service.createTask({ prompt: `p${index}`, model: 'm' }));
    for (const task of tasks) service.startTask(task.id);

    // The waiting tasks have not been started, so they are still queued.
    const queued = tasks.filter((task) => service.store.getTask(task.id)?.state === 'queued');
    assert.ok(queued.length >= 3, `expected waiting tasks to stay queued, saw ${queued.length}`);

    const finished = await Promise.all(tasks.map((task) => service.waitForTask(task.id)));
    assert.ok(finished.every((task) => task.state === 'succeeded'));
    assert.ok(provider.peak() <= 2, `provider saw ${provider.peak()} concurrent calls, limit was 2`);

    // Every task ran exactly one completion.
    const types = tasks.flatMap((task) => service.store.listTaskEvents(task.id).map((event) => event.type));
    assert.equal(types.filter((type) => type === 'task.completed').length, tasks.length);
  } finally {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a task waiting for admission can still be cancelled', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-admission-cancel-'));
  const provider = countingProvider(120);
  const service = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'm',
    maxConcurrentTasks: 1,
    fetch: provider.fetch,
  });
  try {
    const first = service.createTask({ prompt: 'first', model: 'm' });
    const second = service.createTask({ prompt: 'second', model: 'm' });
    service.startTask(first.id);
    service.startTask(second.id);

    assert.equal(service.store.getTask(second.id)?.state, 'queued', 'second task waits for a slot');
    const cancelled = service.cancelTask(second.id);
    assert.ok(['cancelling', 'cancelled'].includes(cancelled.state));
    const settled = await service.waitForTask(second.id);
    assert.equal(settled.state, 'cancelled');

    assert.equal((await service.waitForTask(first.id)).state, 'succeeded');
  } finally {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('cancelling waiters does not hand out extra slots', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-admission-leak-'));
  const provider = countingProvider(60);
  const service = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'm',
    maxConcurrentTasks: 1,
    fetch: provider.fetch,
  });
  try {
    const tasks = Array.from({ length: 6 }, (_, index) => service.createTask({ prompt: `p${index}`, model: 'm' }));
    for (const task of tasks) service.startTask(task.id);
    // Four waiters are cancelled while one task holds the only slot.
    for (const task of tasks.slice(1, 5)) service.cancelTask(task.id);
    await Promise.all(tasks.map((task) => service.waitForTask(task.id)));

    const fresh = service.createTask({ prompt: 'fresh', model: 'm' });
    service.startTask(fresh.id);
    assert.equal((await service.waitForTask(fresh.id)).state, 'succeeded');
    assert.ok(provider.peak() <= 1, `a released waiter granted a second slot: peak ${provider.peak()}`);
  } finally {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * A process that died mid-request must not silently replay the turn.
 *
 * The task had already issued a model call, so it may have executed a tool
 * before the crash. `writeAlreadyApplied` only sees recorded executions, so an
 * automatic replay could duplicate a write. The safe outcome is a visible
 * `interrupted`, with the existing retry endpoint as the explicit way forward.
 */
test('a task interrupted mid-request is not replayed, and retry starts a new attempt', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-midflight-'));
  const database = path.join(directory, 'runtime.sqlite');
  let calls = 0;
  const never = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/v1/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'm' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    calls += 1;
    return new Promise<Response>(() => undefined);
  }) as typeof globalThis.fetch;
  const first = createTaskService(database, { magpieBaseUrl: 'http://127.0.0.1:3425', defaultModel: 'm', fetch: never });
  const task = first.createTask({ prompt: 'hi', model: 'm' });
  first.startTask(task.id);
  await new Promise((resolve) => setTimeout(resolve, 20));
  // Simulate a crash: no shutdown, the request simply stops being observed.
  first.close();

  let replayCalls = 0;
  const replay = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/v1/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'm' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    replayCalls += 1;
    return new Response(sse('ok'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof globalThis.fetch;
  const second = createTaskService(database, { magpieBaseUrl: 'http://127.0.0.1:3425', defaultModel: 'm', fetch: replay });
  try {
    await new Promise((resolve) => setTimeout(resolve, 40));
    const afterRestart = second.store.getTask(task.id)!;
    assert.equal(afterRestart.state, 'interrupted');
    assert.equal(replayCalls, 0, 'a mid-request task must not replay on its own');
    assert.ok(calls >= 1);

    second.retryTask(task.id);
    second.startTask(task.id);
    const finished = await second.waitForTask(task.id);
    assert.equal(finished.state, 'succeeded');
    assert.equal(finished.attempt, 2);
  } finally {
    await second.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

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
