import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyConfigurationRevision,
  createConfigurationRevision,
  createConfigurationRevisionStore,
} from '../src/runtime/configuration-revision.js';

const BASE_INPUT = {
  profile: ['default'],
  skills: [' planner ', 'reviewer'],
  policies: ['loopback-only'],
  mcpServers: ['local-tools'],
};

test('configuration revisions are deterministic and normalize portable inputs', () => {
  const first = createConfigurationRevision(BASE_INPUT);
  const equivalent = createConfigurationRevision({
    profile: ['default', 'default', ' '],
    skills: ['reviewer', 'planner'],
    policies: ['loopback-only'],
    mcpServers: ['local-tools'],
  });

  assert.equal(first.id, equivalent.id);
  assert.deepEqual(first.skills, ['planner', 'reviewer']);
  assert.ok(first.id.startsWith('cfg_'));
});

test('configuration content changes produce a different revision id', () => {
  const first = createConfigurationRevision(BASE_INPUT);
  const changed = createConfigurationRevision({
    ...BASE_INPUT,
    policies: ['loopback-only', 'require-approval'],
  });

  assert.notEqual(first.id, changed.id);
});

test('applying a revision preserves immutable history and pins active state', () => {
  const initialStore = createConfigurationRevisionStore(BASE_INPUT);
  const nextStore = applyConfigurationRevision(initialStore, {
    ...BASE_INPUT,
    mcpServers: ['local-tools', 'browser'],
  });

  assert.equal(initialStore.history.length, 1);
  assert.equal(nextStore.history.length, 2);
  assert.equal(nextStore.history[0]?.id, initialStore.active.id);
  assert.equal(nextStore.active.id, nextStore.history[1]?.id);
  assert.notEqual(initialStore.active.id, nextStore.active.id);
  assert.ok(Object.isFrozen(nextStore.history));
});

test('applying an equivalent revision does not add history', () => {
  const store = createConfigurationRevisionStore(BASE_INPUT);
  const unchanged = applyConfigurationRevision(store, {
    ...BASE_INPUT,
    profile: [' default ', 'default'],
  });

  assert.equal(unchanged, store);
});
