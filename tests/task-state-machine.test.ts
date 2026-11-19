import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canTransition,
  isTerminalTaskState,
  TASK_STATES,
  TERMINAL_TASK_STATES,
  type TaskState,
} from '../src/runtime/task-lifecycle.js';

// The canonical table from docs/ARCHITECTURE.md. If the code diverges, one of
// these assertions fails, which is the point: an undocumented transition is a
// bug waiting to happen.
const EXPECTED: Record<TaskState, readonly TaskState[]> = {
  queued: ['running', 'cancelling', 'failed', 'interrupted'],
  running: ['waiting_approval', 'cancelling', 'succeeded', 'failed', 'interrupted'],
  waiting_approval: ['running', 'cancelling', 'failed', 'interrupted'],
  cancelling: ['cancelled', 'interrupted'],
  succeeded: [],
  failed: [],
  cancelled: [],
  interrupted: ['running'],
};

test('every task state is covered by the documented table', () => {
  assert.deepEqual([...TASK_STATES].sort(), Object.keys(EXPECTED).sort());
});

test('the implemented transitions match the documented table exactly', () => {
  for (const from of TASK_STATES) {
    for (const to of TASK_STATES) {
      const expected = EXPECTED[from].includes(to);
      assert.equal(canTransition(from, to), expected, `${from} -> ${to}`);
    }
  }
});

test('terminal states are exactly the ones with no forward transitions', () => {
  for (const state of TASK_STATES) {
    const movesOnward = TASK_STATES.some((to) => canTransition(state, to));
    assert.equal(isTerminalTaskState(state), !movesOnward || state === 'interrupted',
      `${state} terminal=${isTerminalTaskState(state)} movesOnward=${movesOnward}`);
  }
});

test('interrupted can only resume to running, never skip to success', () => {
  assert.equal(canTransition('interrupted', 'running'), true);
  assert.equal(canTransition('interrupted', 'succeeded'), false);
  assert.equal(canTransition('interrupted', 'failed'), false);
  assert.equal(canTransition('interrupted', 'cancelled'), false);
});

test('cancellation is terminal once reached', () => {
  assert.equal(canTransition('cancelling', 'cancelled'), true);
  for (const to of ['running', 'queued', 'succeeded'] as const) {
    assert.equal(canTransition('cancelled', to), false);
  }
});

test('terminal task states cannot be re-entered from themselves', () => {
  for (const state of TERMINAL_TASK_STATES) {
    assert.equal(canTransition(state, state), false, `${state} -> ${state}`);
  }
});
