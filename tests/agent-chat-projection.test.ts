import assert from 'node:assert/strict';
import test from 'node:test';
import { projectMessage } from '../src/runtime/agent-chat-projection.js';
import type { AgentChatMessage } from '../src/runtime/agent-chat-types.js';
import type { TaskSnapshot } from '../src/runtime/task-store.js';

/**
 * The projection contract.
 *
 * One implementation serves two callers with different consequences: the write
 * path persists it, the read path returns it without persisting. Both rely on
 * the same rule that `null` means "nothing changed", so that is asserted here
 * rather than inferred from either caller.
 */
function message(over: Partial<AgentChatMessage> = {}): AgentChatMessage {
  return {
    id: 'amsg_1',
    sequence: 2,
    author: 'assistant',
    body: '',
    state: 'thinking',
    taskId: 'task_1',
    error: null,
    phase: 'preparing',
    progress: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
    replyToId: null,
    activity: [],
    ...over,
  } as AgentChatMessage;
}

function task(over: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return { id: 'task_1', attempt: 1, state: 'running', ...over } as TaskSnapshot;
}

const now = '2026-01-01T00:00:01.000Z';

test('a running task with partial output projects a streaming body', () => {
  const projected = projectMessage({
    message: message(),
    task: task({ state: 'running', partialOutput: 'half' }),
    activity: [],
    now,
  });
  assert.ok(projected);
  assert.equal(projected!.body, 'half');
  assert.equal(projected!.state, 'streaming');
  assert.equal(projected!.phase, 'model');
  assert.equal(projected!.progress, 5);
});

test('an unchanged running task projects nothing', () => {
  // `null` is what lets both callers skip a write and skip a re-render.
  const projected = projectMessage({
    message: message({ state: 'thinking', activity: [] }),
    task: task({ state: 'queued' }),
    activity: [],
    now,
  });
  assert.equal(projected, null);
});

test('a successful task projects done with the real output', () => {
  // `done` (unread) is the terminal projection; reading promotes it later.
  const projected = projectMessage({
    message: message(),
    task: task({ state: 'succeeded', output: '完成。' }),
    activity: [],
    now,
  });
  assert.ok(projected);
  assert.equal(projected!.state, 'done');
  assert.equal(projected!.body, '完成。');
  assert.equal(projected!.progress, 100);
  assert.equal(projected!.error, null);
});

test('a failed task carries a bounded error and no progress', () => {
  const projected = projectMessage({
    message: message(),
    task: task({ state: 'failed', error: 'boom' }),
    activity: [],
    now,
  });
  assert.ok(projected);
  assert.equal(projected!.state, 'failed');
  assert.equal(projected!.error, 'boom');
  assert.equal(projected!.progress, null);
});

test('an unavailable provider is distinguished from a plain failure', () => {
  const projected = projectMessage({
    message: message(),
    task: task({ state: 'failed', error: 'model catalog is unavailable' }),
    activity: [],
    now,
  });
  assert.equal(projected!.state, 'unavailable');
});

test('an operator rejection is explained rather than called a model failure', () => {
  const projected = projectMessage({
    message: message(),
    task: task({ state: 'failed', error: 'rejected by the operator' }),
    activity: [],
    now,
  });
  assert.match(projected!.body, /拒绝/);
});

test('a cancelled task says so', () => {
  const projected = projectMessage({
    message: message(),
    task: task({ state: 'cancelled' }),
    activity: [],
    now,
  });
  assert.equal(projected!.state, 'cancelled');
  assert.match(projected!.body, /取消/);
});

test('a missing task becomes a failed message', () => {
  const projected = projectMessage({ message: message(), task: null, activity: [], now });
  assert.equal(projected!.state, 'failed');
  assert.equal(projected!.error, 'Task not found.');
});

test('terminal and non-assistant messages are never re-projected', () => {
  assert.equal(projectMessage({
    message: message({ state: 'done' }), task: task(), activity: [], now,
  }), null);
  assert.equal(projectMessage({
    message: message({ author: 'user', state: 'published' }), task: task(), activity: [], now,
  }), null);
  assert.equal(projectMessage({
    message: message({ taskId: null }), task: task(), activity: [], now,
  }), null);
});

test('activity changes alone are enough to project', () => {
  const projected = projectMessage({
    message: message({ state: 'thinking', activity: [] }),
    task: task({ state: 'queued' }),
    activity: [{ id: 'a', kind: 'turn', label: '思考中', state: 'running', detail: null }],
    now,
  });
  assert.ok(projected);
  assert.equal(projected!.activity.length, 1);
});
