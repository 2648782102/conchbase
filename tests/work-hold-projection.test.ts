import assert from 'node:assert/strict';
import test from 'node:test';
import { projectWorkHolds } from '../src/runtime/work-hold-projection.js';
import type { OrganizationSnapshot } from '../src/runtime/organization-contract.js';

/** Hold projection explains why authorized work is not yet running. */

function snapshot(
  workers: readonly { id: string; state: 'authorized' | 'idle' | 'running' | 'reporting' }[],
  options: { readonly projects?: number; readonly openAttention?: boolean } = {},
): OrganizationSnapshot {
  const projectIds = Array.from({ length: options.projects ?? 1 }, (_, index) => `project_${index}`);
  return {
    version: 1,
    bossSession: { version: 1, id: 'boss_1', state: 'active', projectIds },
    projects: projectIds.map((id) => ({
      version: 1, id, bossSessionId: 'boss_1', originTriggerId: `int_${id}`, state: 'active',
    })),
    delegations: [],
    workers: workers.map((worker, index) => ({
      version: 1,
      id: worker.id,
      projectId: projectIds[index % projectIds.length]!,
      delegationId: `del_${worker.id}`,
      agentRevisionId: `agr_${worker.id}`,
      displayName: worker.id,
      instructionsDigest: 'sha256:x',
      model: { providerId: 'magpie', modelId: 'm' },
      state: worker.state,
    })),
    reports: [],
    attentionRequests: options.openAttention
      ? [{
        version: 1, id: 'att_1', projectId: projectIds[0]!, workerId: workers[0]?.id ?? 'none',
        state: 'open', questionDigest: 'sha256:q', sequence: 1,
      }]
      : [],
    events: [],
  } as OrganizationSnapshot;
}

test('an authorized worker above project capacity is reported as held', () => {
  const holds = projectWorkHolds(
    snapshot([
      { id: 'w1', state: 'authorized' },
      { id: 'w2', state: 'authorized' },
    ]),
    { globalActive: 8, perProjectActive: 1 },
  );
  assert.deepEqual(holds.map((hold) => [hold.workItemId, hold.heldBy]), [
    ['work_w2', 'project-limit'],
  ]);
});

test('running workers consume capacity and are never themselves held', () => {
  const holds = projectWorkHolds(
    snapshot([
      { id: 'w1', state: 'running' },
      { id: 'w2', state: 'authorized' },
      { id: 'w3', state: 'authorized' },
    ], { projects: 1 }),
    { globalActive: 8, perProjectActive: 1 },
  );
  assert.ok(!holds.some((hold) => hold.workItemId === 'work_w1'));
  assert.ok(holds.some((hold) => hold.workItemId === 'work_w2'));
});

test('custom limits are respected', () => {
  const holds = projectWorkHolds(
    snapshot([
      { id: 'w1', state: 'authorized' },
      { id: 'w2', state: 'authorized' },
      { id: 'w3', state: 'authorized' },
    ], { projects: 3 }),
    { globalActive: 2, perProjectActive: 1 },
  );
  assert.equal(holds.length, 1);
  assert.equal(holds[0]!.workItemId, 'work_w3');
});

test('the projection is read-only and deterministic', () => {
  const input = snapshot([{ id: 'w1', state: 'authorized' }, { id: 'w2', state: 'authorized' }]);
  const before = JSON.stringify(input);
  const first = projectWorkHolds(input);
  const second = projectWorkHolds(input);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(input), before);
});
