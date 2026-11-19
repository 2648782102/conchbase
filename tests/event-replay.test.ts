import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTaskService } from '../src/runtime/task-service.js';

function sse(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`;
}

function okFetch(): typeof globalThis.fetch {
  return (async () => new Response(sse('done'), {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  })) as typeof globalThis.fetch;
}

test('event ids are strictly increasing with no gaps across a restart', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-replay-'));
  const filename = path.join(directory, 'runtime.sqlite');
  const first = createTaskService(filename, { magpieBaseUrl: 'http://127.0.0.1:3425', defaultModel: 'fixture/model', fetch: okFetch() });
  let before;
  try {
    const a = first.createTask({ prompt: 'one' });
    first.startTask(a.id);
    await first.waitForTask(a.id);
    const b = first.createTask({ prompt: 'two' });
    first.startTask(b.id);
    await first.waitForTask(b.id);
    before = first.store.listEvents(null);
  } finally {
    first.close();
  }
  assert.ok(before.length >= 6, 'expected several events');
  // strictly increasing, gap-free
  for (let i = 1; i < before.length; i += 1) {
    assert.equal(before[i]!.sequence, before[i - 1]!.sequence + 1, `gap at index ${i}`);
  }
  const ids = before.map((event) => event.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');

  // Reopen and replay: identical events in identical order.
  const second = createTaskService(filename, { magpieBaseUrl: 'http://127.0.0.1:3425', defaultModel: 'fixture/model', fetch: okFetch() });
  try {
    const after = second.store.listEvents(null);
    assert.deepEqual(after.map((e) => e.id), ids, 'replay after restart matches');
    const resumed = second.store.listEvents(ids[Math.floor(ids.length / 2)]!);
    const expectedTail = before.slice(Math.floor(ids.length / 2) + 1).map((e) => e.id);
    assert.deepEqual(resumed.map((e) => e.id), expectedTail, 'cursor resumes exactly after the given id');
  } finally {
    second.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an unknown cursor is rejected instead of silently returning everything', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-replay-'));
  const service = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425', defaultModel: 'fixture/model', fetch: okFetch(),
  });
  try {
    const task = service.createTask({ prompt: 'x' });
    service.startTask(task.id);
    await service.waitForTask(task.id);
    assert.throws(() => service.store.listEvents('evt_999999999999'), /Unknown event cursor/);
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('creating a task never reuses an event sequence, even after deletes-free reuse', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-replay-'));
  const service = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425', defaultModel: 'fixture/model', fetch: okFetch(),
  });
  try {
    const seen = new Set<string>();
    for (let i = 0; i < 4; i += 1) {
      const task = service.createTask({ prompt: `t${i}` });
      service.startTask(task.id);
      await service.waitForTask(task.id);
    }
    for (const event of service.store.listEvents(null)) {
      assert.equal(seen.has(event.id), false, `duplicate event id ${event.id}`);
      seen.add(event.id);
    }
    const sequences = service.store.listEvents(null).map((e) => e.sequence);
    assert.deepEqual([...sequences].sort((a, b) => a - b), sequences, 'ordered by sequence');
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
