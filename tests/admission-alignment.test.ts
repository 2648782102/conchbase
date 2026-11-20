import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTaskService } from '../src/runtime/task-service.js';

/**
 * Two gates over one capacity must not disagree.
 *
 * The work scheduler counts running WorkItems; the task layer counts held model
 * calls. Each was correct on its own and neither could see the other, so the
 * scheduler could admit eight work items while the task layer delivered four —
 * leaving WorkItems `running` whose tasks sat in `queued`.
 *
 * `availableModelSlots` is the number that closes the gap. It has to be exact:
 * too high and the scheduler over-admits again; too low and it starves work that
 * could have run.
 */

function blockingFetch(): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/v1/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'm' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    // Held open so the task keeps its slot while the assertions run, but
    // abortable so `stop()` can still shut the service down.
    const signal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      if (signal?.aborted) { reject(new Error('aborted')); return; }
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  }) as typeof globalThis.fetch;
}

interface Fixture {
  readonly service: ReturnType<typeof createTaskService>;
  readonly ids: readonly string[];
}

async function withFullRuntime(
  taskCount: number,
  run: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-admission-align-'));
  const service = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'm',
    fetch: blockingFetch(),
    maxConcurrentTasks: 2,
  });
  try {
    const ids = Array.from({ length: taskCount }, (_, index) =>
      service.createTask({ prompt: `p${index}`, model: 'm' }).id);
    for (const id of ids) service.startTask(id);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await run({ service, ids });
  } finally {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}

test('available slots are reported before anything starts', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-slots-fresh-'));
  const service = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425', defaultModel: 'm', maxConcurrentTasks: 3,
  });
  try {
    assert.equal(service.availableModelSlots, 3);
  } finally {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('slots fall to zero once the limit is held and never go negative', async () => {
  await withFullRuntime(5, async ({ service }) => {
    // Two running, three waiting: the gate is saturated.
    assert.equal(service.availableModelSlots, 0);
  });
});

test('a queued task over the limit is visible as waiting, not running', async () => {
  await withFullRuntime(4, async ({ service, ids }) => {
    const states = ids.map((id) => service.store.getTask(id)?.state);
    assert.equal(states.filter((state) => state === 'running').length, 2);
    assert.equal(states.filter((state) => state === 'queued').length, 2);
  });
});

test('a released slot is reported as available again', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-slots-release-'));
  const gate: { release: (() => void) | null } = { release: null };
  const fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/v1/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'm' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    await new Promise<void>((resolve) => { gate.release = resolve; });
    return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    });
  }) as typeof globalThis.fetch;
  const service = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425', defaultModel: 'm', fetch, maxConcurrentTasks: 1,
  });
  try {
    const task = service.createTask({ prompt: 'p', model: 'm' });
    service.startTask(task.id);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(service.availableModelSlots, 0);

    gate.release?.();
    await service.waitForTask(task.id);
    assert.equal(service.availableModelSlots, 1, 'a finished task returns its slot');
  } finally {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
