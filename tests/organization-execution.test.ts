import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  applyOrganizationAction,
  createOrganization,
  type OrganizationSnapshot,
} from '../src/runtime/organization-contract.js';
import {
  ORGANIZATION_EXECUTION_CONTRACT_VERSION,
  planOrganizationExecution,
} from '../src/runtime/organization-execution.js';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const model = { providerId: 'local', modelId: 'test-model' } as const;

function action(snapshot: OrganizationSnapshot, input: Record<string, unknown>): OrganizationSnapshot {
  return applyOrganizationAction(snapshot, { ...input, expectedSequence: snapshot.events.length });
}

function withWorkers(count: number): OrganizationSnapshot {
  let snapshot = action(createOrganization('conversation_main'), {
    type: 'open_project',
    projectId: 'project_alpha',
    originTriggerId: 'trigger_one',
  });
  snapshot = action(snapshot, { type: 'activate_project', projectId: 'project_alpha' });
  for (let index = 1; index <= count; index += 1) {
    snapshot = action(snapshot, {
      type: 'create_agent',
      projectId: 'project_alpha',
      workerId: `worker_${index}`,
      delegationId: `delegation_${index}`,
      agentRevisionId: `agent_revision_${index}`,
      displayName: `Worker ${index}`,
      instructionsDigest: 'sha256_instructions',
      scope: ['project:alpha'],
      capabilities: ['cap_read_context'],
      model,
      maxDelegationDepth: 0,
      ttlEvents: 50,
    });
    snapshot = action(snapshot, {
      type: 'authorize_worker',
      projectId: 'project_alpha',
      workerId: `worker_${index}`,
    });
  }
  return snapshot;
}

test('organization execution planner enforces bounded concurrent launches', () => {
  const snapshot = withWorkers(4);
  const plan = planOrganizationExecution(snapshot, [], { globalActive: 3, perProjectActive: 1 });
  assert.equal(plan.version, ORGANIZATION_EXECUTION_CONTRACT_VERSION);
  assert.equal(plan.commands.length, 1);
  assert.equal(plan.commands[0]?.type, 'start_work');
  assert.equal(plan.commands[0]?.expectedState, 'open');
  assert.equal(plan.activeWorkItemIds.length, 1);
});

test('open attention prevents new autonomous launches', () => {
  let snapshot = withWorkers(1);
  snapshot = action(snapshot, { type: 'start_worker', projectId: 'project_alpha', workerId: 'worker_1' });
  snapshot = action(snapshot, {
    type: 'report_worker',
    projectId: 'project_alpha',
    workerId: 'worker_1',
    reportId: 'report_blocked',
    state: 'blocked',
    summaryDigest: 'sha256_report_blocked',
  });
  snapshot = action(snapshot, {
    type: 'request_attention',
    projectId: 'project_alpha',
    workerId: 'worker_1',
    attentionId: 'attention_one',
    questionDigest: 'sha256_question',
  });
  const plan = planOrganizationExecution(snapshot, []);
  assert.equal(plan.commands.length, 0);
  assert.equal(plan.relays.some((relay) => relay.kind === 'attention'), true);
});

test('primary relay includes meaningful facts but not routine progress', () => {
  let snapshot = withWorkers(1);
  snapshot = action(snapshot, { type: 'start_worker', projectId: 'project_alpha', workerId: 'worker_1' });
  snapshot = action(snapshot, {
    type: 'report_worker',
    projectId: 'project_alpha',
    workerId: 'worker_1',
    reportId: 'report_progress',
    state: 'progress',
    summaryDigest: 'sha256_progress',
  });
  snapshot = action(snapshot, {
    type: 'report_worker',
    projectId: 'project_alpha',
    workerId: 'worker_1',
    reportId: 'report_ready',
    state: 'ready',
    summaryDigest: 'sha256_ready',
  });
  const plan = planOrganizationExecution(snapshot, []);
  assert.equal(plan.relays.length, 1);
  assert.equal(plan.relays[0]?.kind, 'result');
  assert.equal(plan.relays[0]?.digest, 'sha256_ready');
  assert.equal(plan.relays.some((relay) => relay.digest === 'sha256_progress'), false);
});

test('planner emits only published work-control vocabulary and bounded values', () => {
  const snapshot = withWorkers(1);
  const plan = planOrganizationExecution(snapshot, [{
    id: 'work_existing',
    state: 'running',
    assignmentIds: ['assignment_one'],
    interruptedAssignmentIds: ['assignment_interrupted'],
  }, {
    id: `work_worker_1`,
    state: 'completed',
    assignmentIds: [],
    interruptedAssignmentIds: [],
  }]);
  assert.deepEqual(plan.commands.map((command) => command.type), ['reconcile_assignment']);
  assert.equal(plan.commands[0]?.outcome, 'failed');
  for (const command of plan.commands) {
    assert.ok(['open', 'paused', 'running'].includes(command.expectedState));
    assert.ok(/^[a-z][a-z0-9_-]*$/.test(command.workItemId));
  }
  assert.doesNotMatch(JSON.stringify(plan), /sk-|Bearer|password|apiKey|privateKey/);
  assert.throws(
    () => planOrganizationExecution(snapshot, [], { globalActive: 0, perProjectActive: 1 }),
    RangeError,
  );

  const spec = readFileSync(path.join(repositoryRoot, 'docs/openapi.yaml'), 'utf8');
  assert.equal([...spec.matchAll(/^  (\/v1\/[^:]+):$/gm)].length, 65);
});
