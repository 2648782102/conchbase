import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { OrganizationCoordinator } from '../src/runtime/organization-coordinator.js';
import { InMemoryOrganizationStore } from '../src/runtime/organization-store.js';
import { OrganizationConflictError } from '../src/runtime/organization-contract.js';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

function workerAction(workerId = 'worker_alpha') {
  return {
    type: 'create_agent',
    expectedSequence: 2,
    projectId: 'project_alpha',
    workerId,
    delegationId: `delegation_${workerId}`,
    agentRevisionId: `revision_${workerId}`,
    displayName: 'Worker',
    instructionsDigest: 'sha256_instructions',
    scope: ['project:alpha'],
    capabilities: ['cap_read_context'],
    model: { providerId: 'local', modelId: 'test-model' },
    maxDelegationDepth: 0,
    ttlEvents: 50,
  };
}

function setup(overrides: Record<string, unknown> = {}) {
  const store = new InMemoryOrganizationStore();
  store.apply({
    type: 'open_project', expectedSequence: 0,
    projectId: 'project_alpha', originTriggerId: 'trigger_one',
  });
  store.apply({ type: 'activate_project', expectedSequence: 1, projectId: 'project_alpha' });
  store.apply(workerAction());
  const calls: string[] = [];
  let failStart = false;
  const coordinator = new OrganizationCoordinator(store, {
    listWorkState: () => [],
    startWork: (workItemId, expectedState) => {
      calls.push(`start:${workItemId}:${expectedState}`);
      if (failStart) throw new Error('control failed');
    },
    ...overrides,
  });
  return { store, coordinator, calls, setFailStart: (value: boolean) => { failStart = value; } };
}

test('coordinator applies one action and dispatches only injected work controls', () => {
  const { store, coordinator, calls } = setup();
  const result = coordinator.submitAction({
    type: 'authorize_worker',
    expectedSequence: 3,
    projectId: 'project_alpha',
    workerId: 'worker_alpha',
  });
  assert.equal(store.get().events.length, 4);
  assert.deepEqual(calls, ['start:work_worker_alpha:open']);
  assert.equal(result.executions[0]?.outcome, 'dispatched');
  assert.equal(result.relays.length, 0);
});

test('coordinator rejects stale actions before dispatch', () => {
  const { coordinator, calls } = setup();
  assert.throws(
    () => coordinator.submitAction({
      type: 'authorize_worker', expectedSequence: 99,
      projectId: 'project_alpha', workerId: 'worker_alpha',
    }),
    OrganizationConflictError,
  );
  assert.deepEqual(calls, []);
});

test('coordinator surfaces control failures without erasing committed facts', () => {
  const { store, coordinator, calls, setFailStart } = setup();
  setFailStart(true);
  coordinator.submitAction({
    type: 'authorize_worker', expectedSequence: 3,
    projectId: 'project_alpha', workerId: 'worker_alpha',
  });
  assert.equal(store.get().events.length, 4);
  assert.equal(calls.length, 1);

  setFailStart(false);
  const retry = coordinator.reconcile();
  assert.equal(retry.executions[0]?.outcome, 'dispatched');
  assert.equal(calls.length, 2);
});

test('coordinator has no HTTP, Agent store, model, tool, or public contract dependency', () => {
  const source = readFileSync(
    path.join(repositoryRoot, 'src/runtime/organization-coordinator.ts'),
    'utf8',
  );
  assert.doesNotMatch(source, /fastify|createAgent\(|fetch\(|spawn|exec\(|readFile/);
  const spec = readFileSync(path.join(repositoryRoot, 'docs/openapi.yaml'), 'utf8');
  /*
   * The surface must keep growing deliberately, not by accident. The number is
   * asserted against the published paths so adding a route is a one-line edit
   * here rather than a silent change to what the coordinator is measured against.
   */
  const publishedPaths = [...spec.matchAll(/^  (\/v1\/[^:]+):$/gm)].length;
  assert.equal(publishedPaths, 101, `expected 101 published paths, found ${publishedPaths}`);
  assert.doesNotMatch(source, /organization\/session/);
});

test('coordinator admits only scheduled starts and exposes hold reasons', () => {
  const store = new InMemoryOrganizationStore();
  store.apply({
    type: 'open_project', expectedSequence: 0,
    projectId: 'project_alpha', originTriggerId: 'trigger_one',
  });
  store.apply({ type: 'activate_project', expectedSequence: 1, projectId: 'project_alpha' });
  store.apply({ ...workerAction('worker_one'), expectedSequence: 2 });
  store.apply({
    type: 'authorize_worker', expectedSequence: 3,
    projectId: 'project_alpha', workerId: 'worker_one',
  });
  store.apply({ ...workerAction('worker_two'), workerId: 'worker_two', expectedSequence: 4 });
  store.apply({
    type: 'authorize_worker', expectedSequence: 5,
    projectId: 'project_alpha', workerId: 'worker_two',
  });

  const calls: string[] = [];
  const coordinator = new OrganizationCoordinator(store, {
    // No WorkItems exist yet: the planner derives two start_work commands from
    // the two authorized workers, which is exactly the admission seam.
    listWorkState: () => [],
    startWork: (workItemId, expectedState) => { calls.push(`start:${workItemId}:${expectedState}`); },
  }, undefined, { globalActive: 1, perProjectActive: 1 });

  const result = coordinator.reconcile();
  assert.equal(calls.length, 1, 'only one work item may start');
  assert.equal(result.holds.length, 1);
  assert.ok(['global-limit', 'project-limit'].includes(result.holds[0]!.reason));
  assert.equal(
    result.executions.filter((execution) => execution.command.type === 'start_work').length,
    1,
  );
});

test('reconcile is idempotent for valid work controls and capacity holds', () => {
  const store = new InMemoryOrganizationStore();
  store.apply({
    type: 'open_project', expectedSequence: 0,
    projectId: 'project_alpha', originTriggerId: 'trigger_one',
  });
  store.apply({ type: 'activate_project', expectedSequence: 1, projectId: 'project_alpha' });
  store.apply({ ...workerAction('worker_one'), expectedSequence: 2 });
  store.apply({
    type: 'authorize_worker', expectedSequence: 3,
    projectId: 'project_alpha', workerId: 'worker_one',
  });
  const calls: string[] = [];
  const coordinator = new OrganizationCoordinator(store, {
    // Returning an already-running WorkItem makes the planner skip start_work;
    // repeated reconcile must therefore neither start nor invent a new hold.
    listWorkState: () => [
      { id: 'work_worker_one', state: 'running', assignmentIds: [], interruptedAssignmentIds: [] },
    ],
    startWork: (workItemId) => { calls.push(workItemId); },
  }, undefined, { globalActive: 1, perProjectActive: 1 });
  const first = coordinator.reconcile();
  const second = coordinator.reconcile();
  assert.deepEqual(calls, []);
  assert.equal(first.executions.length, 0);
  assert.equal(second.executions.length, 0);
  assert.equal(first.holds.length, 0);
  assert.equal(second.holds.length, 0);
});
