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
  assert.equal([...spec.matchAll(/^  (\/v1\/[^:]+):$/gm)].length, 83);
  assert.doesNotMatch(source, /organization\/session/);
});
