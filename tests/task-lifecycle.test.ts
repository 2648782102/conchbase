import assert from 'node:assert/strict';
import test from 'node:test';
import { createConfigurationRevisionStore } from '../src/runtime/configuration-revision.js';
import {
  InvalidTaskTransitionError,
  createTaskRecord,
  isTerminalTaskState,
  transitionTask,
  type TaskEventType,
  type TaskRecord,
} from '../src/runtime/task-lifecycle.js';

const INPUT = {
  profile: ['default'],
  skills: [],
  policies: [],
  mcpServers: [],
};

function applyEvents(task: TaskRecord, eventTypes: readonly TaskEventType[]): TaskRecord {
  return eventTypes.reduce((current, eventType) => transitionTask(current, eventType), task);
}

test('a task follows the approval and completion path', () => {
  const revision = createConfigurationRevisionStore(INPUT).active;
  const task = createTaskRecord('task_1', revision.id);

  const completed = applyEvents(task, [
    'task.started',
    'task.approval_requested',
    'task.approved',
    'task.completed',
  ]);

  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.configurationRevisionId, revision.id);
  assert.equal(isTerminalTaskState(completed.state), true);
});

test('a task can fail or be cancelled from an active state', () => {
  const revision = createConfigurationRevisionStore(INPUT).active;
  const task = createTaskRecord('task_2', revision.id);

  const failed = applyEvents(task, ['task.started', 'task.failed']);
  const cancelled = applyEvents(task, [
    'task.started',
    'task.cancellation_requested',
    'task.cancelled',
  ]);

  assert.equal(failed.state, 'failed');
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(isTerminalTaskState(failed.state), true);
  assert.equal(isTerminalTaskState(cancelled.state), true);
});

test('terminal tasks reject further transitions', () => {
  const revision = createConfigurationRevisionStore(INPUT).active;
  const task = createTaskRecord('task_3', revision.id);
  const completed = applyEvents(task, ['task.started', 'task.completed']);

  assert.throws(
    () => transitionTask(completed, 'task.started'),
    InvalidTaskTransitionError,
  );
});

test('incompatible transitions are rejected', () => {
  const revision = createConfigurationRevisionStore(INPUT).active;
  const task = createTaskRecord('task_4', revision.id);

  assert.throws(
    () => transitionTask(task, 'task.completed'),
    (error: unknown) => error instanceof InvalidTaskTransitionError
      && error.from === 'queued'
      && error.to === 'succeeded',
  );
});

test('task records require a non-empty id', () => {
  const revision = createConfigurationRevisionStore(INPUT).active;
  assert.throws(() => createTaskRecord(' ', revision.id), /must not be empty/);
});
