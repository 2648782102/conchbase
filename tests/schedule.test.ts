import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  MAX_INTERVAL_MS,
  MIN_INTERVAL_MS,
  isDue,
  nextRunAfter,
  parseScheduleInput,
} from '../src/runtime/schedule.js';
import { createScheduleRunner } from '../src/runtime/schedule-runner.js';
import { SqliteTaskStore } from '../src/runtime/task-store.js';
import { TaskService } from '../src/runtime/task-service.js';
import type { ModelCatalogClient } from '../src/runtime/model-catalog.js';

const now = '2026-11-21T00:00:00.000Z';
const catalog: ModelCatalogClient = {
  async listModels() {
    return [{ id: 'fixture/chat-model', displayName: 'Fixture' }];
  },
};

function sse(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`;
}

test('a schedule interval is bounded in both directions', () => {
  const base = { name: 'daily', agentId: 'agt_x', prompt: 'report' };
  assert.throws(() => parseScheduleInput({ ...base, intervalMs: MIN_INTERVAL_MS - 1 }, now), /between/);
  assert.throws(() => parseScheduleInput({ ...base, intervalMs: MAX_INTERVAL_MS + 1 }, now), /between/);
  assert.throws(() => parseScheduleInput({ ...base, intervalMs: 1.5 }, now), /integer/);
  const ok = parseScheduleInput({ ...base, intervalMs: MIN_INTERVAL_MS }, now);
  assert.equal(ok.intervalMs, MIN_INTERVAL_MS);
});

test('unknown fields and bad timestamps are refused', () => {
  const base = { name: 'n', agentId: 'a', prompt: 'p', intervalMs: 60_000 };
  assert.throws(() => parseScheduleInput({ ...base, cron: '* * * * *' }, now), /Unknown fields/);
  assert.throws(() => parseScheduleInput({ ...base, startAt: 'tomorrow' }, now), /ISO timestamp/);
  assert.throws(() => parseScheduleInput({ ...base, enabled: 'yes' }, now), /boolean/);
});

test('dueness follows the stored deadline, and the next run resumes the cadence', () => {
  const schedule = {
    enabled: true,
    intervalMs: 60_000,
    nextRunAt: '2026-11-21T00:01:00.000Z',
  };
  assert.equal(isDue(schedule as never, '2026-11-21T00:00:30.000Z'), false);
  assert.equal(isDue(schedule as never, '2026-11-21T00:01:00.000Z'), true);
  assert.equal(isDue({ ...schedule, enabled: false } as never, now), false);
  // A long downtime must not produce back-dated runs.
  assert.equal(nextRunAfter(schedule, '2026-11-22T00:00:00.000Z'), '2026-11-22T00:01:00.000Z');
});

test('the store round-trips a schedule and honours enable/disable', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-schedule-store-'));
  try {
    const store = new SqliteTaskStore(path.join(directory, 'runtime.sqlite'));
    try {
      const input = parseScheduleInput(
        { name: '早报', agentId: 'agt_x', prompt: '总结昨天' , intervalMs: 3_600_000 },
        now,
      );
      const created = store.schedules.create(input, now);
      assert.equal(created.enabled, true);
      assert.equal(store.schedules.list().length, 1);
      assert.equal(store.schedules.get(created.id)?.name, '早报');

      const disabled = store.schedules.update(created.id, { enabled: false });
      assert.equal(disabled.enabled, false);
      assert.equal(store.schedules.remove(created.id), true);
      assert.equal(store.schedules.list().length, 0);
    } finally {
      store.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a due schedule creates and starts a real Agent task', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-schedule-run-'));
  const fetchImpl = (async () => new Response(sse('定时结果'), {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  })) as typeof globalThis.fetch;
  const service = new TaskService(
    new SqliteTaskStore(path.join(directory, 'runtime.sqlite')),
    { magpieBaseUrl: 'http://127.0.0.1:3425', defaultModel: 'fixture/chat-model', fetch: fetchImpl },
    catalog,
  );
  try {
    const agent = await service.createAgent({
      name: '定时员', instructions: '', providerId: 'magpie', modelId: 'fixture/chat-model',
    });
    const input = parseScheduleInput(
      { name: '每时', agentId: agent.id, prompt: '报告', intervalMs: 60_000, startAt: now },
      now,
    );
    const schedule = service.store.schedules.create(input, now);
    const runner = createScheduleRunner({
      store: service.store.schedules,
      taskService: service,
      now: () => now,
    });
    const results = await runner.runOnce();
    assert.equal(results.length, 1);
    assert.equal(results[0]?.outcome, 'created');
    const taskId = results[0]?.taskId!;
    const finished = await service.waitForTask(taskId);
    assert.equal(finished.state, 'succeeded');
    assert.equal(finished.output, '定时结果');
    // The schedule records what it did and moves its own deadline.
    const after = service.store.schedules.get(schedule.id)!;
    assert.equal(after.lastTaskId, taskId);
    assert.equal(after.lastRunAt, now);
    assert.ok(Date.parse(after.nextRunAt) > Date.parse(now));
  } finally {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a schedule whose Agent disappeared disables itself instead of retrying forever', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-schedule-fail-'));
  const service = new TaskService(
    new SqliteTaskStore(path.join(directory, 'runtime.sqlite')),
    { magpieBaseUrl: 'http://127.0.0.1:3425', defaultModel: 'fixture/chat-model' },
    catalog,
  );
  try {
    const input = parseScheduleInput(
      { name: '孤儿', agentId: 'agt_missing', prompt: 'x', intervalMs: 60_000, startAt: now },
      now,
    );
    const schedule = service.store.schedules.create(input, now);
    const runner = createScheduleRunner({
      store: service.store.schedules,
      taskService: service,
      now: () => now,
    });
    const results = await runner.runOnce();
    assert.equal(results[0]?.outcome, 'failed');
    assert.equal(service.store.schedules.get(schedule.id)?.enabled, false,
      'a permanently failing schedule must not fire every tick');
    // A second pass finds nothing due.
    assert.deepEqual(await runner.runOnce(), []);
  } finally {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
