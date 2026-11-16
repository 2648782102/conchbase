import assert from 'node:assert/strict';
import test from 'node:test';
import { restoreWorkerExecutions } from '../src/runtime/worker-execution-restore.js';
import type { OrganizationSnapshot } from '../src/runtime/organization-contract.js';

function snapshot(over: Partial<OrganizationSnapshot> & { events?: unknown[] }): OrganizationSnapshot {
  return {
    version: 1,
    bossSession: { version: 1, id: 'boss_1', state: 'active', projectIds: [] },
    projects: [],
    delegations: [],
    workers: [],
    reports: [],
    attentionRequests: [],
    events: [],
    ...over,
  } as unknown as OrganizationSnapshot;
}

const worker = {
  version: 1,
  id: 'wrk_1',
  projectId: 'project_1',
  delegationId: 'del_1',
  agentRevisionId: 'agr_1',
  displayName: '员工',
  instructionsDigest: 'sha256:x',
  model: { providerId: 'magpie', modelId: 'm' },
  state: 'reporting',
};

function executionEvent(data: Record<string, string>, projectId = 'project_1') {
  return {
    version: 1 as const, id: 'evt_1', sequence: 1,
    type: 'organization.worker_execution_recorded', projectId, data,
  };
}

test('a complete event becomes one binding', () => {
  const records = restoreWorkerExecutions(snapshot({
    workers: [worker] as never,
    events: [executionEvent({ workerId: 'wrk_1', taskId: 'task_1', workItemId: 'work_1', agentId: 'agt_1' })],
  }));
  assert.equal(records.size, 1);
  const record = records.get('wrk_1')!;
  assert.equal(record.taskId, 'task_1');
  assert.equal(record.agentRevisionId, 'agr_1');
  assert.equal(record.delegationId, 'del_1');
});

test('an incomplete event never becomes a binding', () => {
  // A half-written event must not become something dispatch later trusts.
  for (const data of [
    { taskId: 't', workItemId: 'w', agentId: 'a' },
    { workerId: 'wrk_1', workItemId: 'w', agentId: 'a' },
    { workerId: 'wrk_1', taskId: 't', agentId: 'a' },
    { workerId: 'wrk_1', taskId: 't', workItemId: 'w' },
  ]) {
    const records = restoreWorkerExecutions(snapshot({
      workers: [worker] as never,
      events: [executionEvent(data)],
    }));
    assert.equal(records.size, 0, JSON.stringify(data));
  }
});

test('an event for an unknown worker is ignored', () => {
  const records = restoreWorkerExecutions(snapshot({
    workers: [],
    events: [executionEvent({ workerId: 'wrk_missing', taskId: 't', workItemId: 'w', agentId: 'a' })],
  }));
  assert.equal(records.size, 0);
});

test('a later execution event for the same worker wins', () => {
  // A re-run binds fresh work; the newest binding is the one to dispatch.
  const records = restoreWorkerExecutions(snapshot({
    workers: [worker] as never,
    events: [
      executionEvent({ workerId: 'wrk_1', taskId: 'task_old', workItemId: 'work_old', agentId: 'agt_1' }),
      executionEvent({ workerId: 'wrk_1', taskId: 'task_new', workItemId: 'work_new', agentId: 'agt_1' }),
    ],
  }));
  assert.equal(records.get('wrk_1')!.taskId, 'task_new');
});

test('unrelated event types are ignored', () => {
  const records = restoreWorkerExecutions(snapshot({
    workers: [worker] as never,
    events: [{
      version: 1 as const, id: 'e', sequence: 1,
      type: 'organization.project_opened', projectId: 'p', data: {},
    }],
  }));
  assert.equal(records.size, 0);
});
