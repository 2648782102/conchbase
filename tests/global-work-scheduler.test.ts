import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_SCHEDULER_LIMITS,
  scheduleGlobalWork,
  type SchedulableWork,
} from '../src/runtime/global-work-scheduler.js';

/** Scheduling is policy, not execution: these fixtures never start a task. */

function work(
  workItemId: string,
  projectId: string,
  enqueueSequence: number,
  state: SchedulableWork['state'] = 'open',
  priority: SchedulableWork['priority'] = 'normal',
): SchedulableWork {
  return { workItemId, projectId, enqueueSequence, state, priority };
}

function started(result: ReturnType<typeof scheduleGlobalWork>): readonly string[] {
  return result.decisions
    .filter((decision) => decision.type === 'start')
    .map((decision) => decision.workItemId);
}

test('running work is counted but never stopped', () => {
  const result = scheduleGlobalWork([
    work('w_run', 'p1', 1, 'running'),
    work('w_new', 'p2', 2),
  ]);
  assert.deepEqual(started(result), ['w_new']);
  assert.ok(result.activeWorkItemIds.includes('w_run'));
  assert.ok(!result.decisions.some((decision) =>
    decision.type === 'start' && decision.workItemId === 'w_run'));
});

test('global capacity holds the excess with a visible reason', () => {
  const result = scheduleGlobalWork(
    Array.from({ length: 10 }, (_, index) => work(`w${index}`, `p${index}`, index)),
    { globalActive: 3, perProjectActive: 3 },
  );
  assert.equal(started(result).length, 3);
  const holds = result.decisions.filter((decision) => decision.type === 'hold');
  assert.equal(holds.length, 7);
  assert.ok(holds.every((decision) => decision.type === 'hold' && decision.reason === 'global-limit'));
});

test('per-project capacity holds extra work from the same project', () => {
  const result = scheduleGlobalWork([
    work('w1', 'p1', 1),
    work('w2', 'p1', 2),
    work('w3', 'p2', 3),
    work('w4', 'p1', 4),
  ], { globalActive: 8, perProjectActive: 1 });
  assert.deepEqual(started(result), ['w1', 'w3']);
  const held = result.decisions.find((decision) => decision.workItemId === 'w4');
  assert.ok(held && held.type === 'hold' && held.reason === 'project-limit');
});

test('interactive work outranks older normal work among queued items', () => {
  const result = scheduleGlobalWork([
    work('normal_1', 'p1', 1),
    work('normal_2', 'p2', 2),
    work('interactive', 'p3', 3, 'open', 'interactive'),
  ], { globalActive: 2, perProjectActive: 2 });
  assert.deepEqual(started(result), ['interactive', 'normal_1']);
});

test('a project with fewer running tasks wins the next slot', () => {
  const result = scheduleGlobalWork([
    work('busy_running_1', 'busy', 1, 'running'),
    work('busy_running_2', 'busy', 2, 'running'),
    work('busy_new', 'busy', 3),
    work('quiet_new', 'quiet', 4),
  ], { globalActive: 4, perProjectActive: 3 });
  assert.deepEqual(started(result), ['quiet_new', 'busy_new']);
});

test('same-priority work is stable by enqueue sequence', () => {
  const result = scheduleGlobalWork([
    work('c', 'p1', 3),
    work('a', 'p1', 1),
    work('b', 'p1', 2),
  ], { globalActive: 8, perProjectActive: 8 });
  assert.deepEqual(started(result), ['a', 'b', 'c']);
});

test('limits are validated instead of silently clamped', () => {
  assert.throws(() => scheduleGlobalWork([], { globalActive: 0, perProjectActive: 2 }), /globalActive/);
  assert.throws(() => scheduleGlobalWork([], { globalActive: 99, perProjectActive: 2 }), /globalActive/);
  assert.throws(() => scheduleGlobalWork([], { globalActive: 2, perProjectActive: 0 }), /perProjectActive/);
  assert.ok(DEFAULT_SCHEDULER_LIMITS.globalActive >= DEFAULT_SCHEDULER_LIMITS.perProjectActive);
});

test('the scheduler does not mutate its input', () => {
  const items = [work('w1', 'p1', 1), work('w2', 'p1', 2)];
  const before = JSON.stringify(items);
  scheduleGlobalWork(items, { globalActive: 1, perProjectActive: 1 });
  assert.equal(JSON.stringify(items), before);
});
