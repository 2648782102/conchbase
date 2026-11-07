import assert from 'node:assert/strict';
import test from 'node:test';
import { createConfigurationRevisionStore } from '../src/runtime/configuration-revision.js';
import {
  EventOrderError,
  appendEvent,
  createEventLog,
  replayEvents,
} from '../src/runtime/event-log.js';

const INPUT = {
  profile: ['default'],
  skills: [],
  policies: [],
  mcpServers: [],
};

function buildLog() {
  const revision = createConfigurationRevisionStore(INPUT).active;
  let log = createEventLog();
  log = appendEvent(log, {
    taskId: 'task_1',
    type: 'task.queued',
    state: 'queued',
    configurationRevisionId: revision.id,
  });
  log = appendEvent(log, {
    taskId: 'task_1',
    type: 'task.started',
    state: 'running',
    configurationRevisionId: revision.id,
  });
  log = appendEvent(log, {
    taskId: 'task_1',
    type: 'task.completed',
    state: 'succeeded',
    configurationRevisionId: revision.id,
  });
  return log;
}

test('events receive monotonic sequences and stable ids', () => {
  const events = buildLog().events;

  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3]);
  assert.deepEqual(events.map((event) => event.id), [
    'evt_000000000001',
    'evt_000000000002',
    'evt_000000000003',
  ]);
  assert.ok(Object.isFrozen(events));
});

test('replay from a cursor returns only later events without duplication', () => {
  const log = buildLog();
  const first = log.events[0];
  assert.ok(first);

  const replayed = replayEvents(log, first.id);
  assert.deepEqual(replayed, log.events.slice(1));
  assert.equal(new Set(replayed.map((event) => event.id)).size, replayed.length);
});

test('a null cursor replays all events and an unknown cursor is rejected', () => {
  const log = buildLog();

  assert.deepEqual(replayEvents(log, null), log.events);
  assert.throws(
    () => replayEvents(log, 'evt_missing'),
    EventOrderError,
  );
});
