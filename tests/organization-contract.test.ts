import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ORGANIZATION_CONTRACT_VERSION,
  OrganizationConflictError,
  OrganizationValidationError,
  applyOrganizationAction,
  createOrganization,
  parseOrganizationAction,
} from '../src/runtime/organization-contract.js';

const model = { providerId: 'local', modelId: 'test-model' } as const;

function action(snapshot: ReturnType<typeof createOrganization>, input: Record<string, unknown>) {
  return applyOrganizationAction(snapshot, {
    ...input,
    expectedSequence: snapshot.events.length,
  });
}

function openProject(snapshot: ReturnType<typeof createOrganization>) {
  return action(snapshot, {
    type: 'open_project',
    projectId: 'project_alpha',
    originTriggerId: 'trigger_one',
  });
}

function createWorker(
  snapshot: ReturnType<typeof createOrganization>,
  overrides: Record<string, unknown> = {},
) {
  return action(snapshot, {
    type: 'create_agent',
    projectId: 'project_alpha',
    workerId: 'worker_alpha',
    delegationId: 'delegation_alpha',
    agentRevisionId: 'agent_revision_alpha',
    displayName: 'Project Alpha Worker',
    instructionsDigest: 'sha256_instructions_alpha',
    scope: ['project:alpha'],
    capabilities: ['cap_read_context', 'cap_write_report'],
    model,
    maxDelegationDepth: 2,
    ttlEvents: 100,
    ...overrides,
  });
}

test('organization kernel creates a project and records atomic events', () => {
  const initial = createOrganization('conversation_main');
  assert.equal(initial.version, ORGANIZATION_CONTRACT_VERSION);
  assert.equal(initial.events.length, 0);

  const opened = openProject(initial);
  assert.equal(opened.projects.length, 1);
  assert.equal(opened.projects[0]?.state, 'forming');
  assert.deepEqual(opened.bossSession.projectIds, ['project_alpha']);
  assert.equal(opened.events.length, 1);
  assert.equal(opened.events[0]?.type, 'organization.project_opened');
  assert.equal(opened.events[0]?.sequence, 1);
});

test('worker lifecycle requires authorization before start and report', () => {
  const opened = openProject(createOrganization('conversation_main'));
  const active = action(opened, {
    type: 'activate_project',
    projectId: 'project_alpha',
  });
  const proposed = createWorker(active);
  assert.equal(proposed.workers[0]?.state, 'proposed');

  const authorized = action(proposed, {
    type: 'authorize_worker',
    projectId: 'project_alpha',
    workerId: 'worker_alpha',
  });
  assert.equal(authorized.workers[0]?.state, 'authorized');

  const running = action(authorized, {
    type: 'start_worker',
    projectId: 'project_alpha',
    workerId: 'worker_alpha',
  });
  assert.equal(running.workers[0]?.state, 'running');

  const reported = action(running, {
    type: 'report_worker',
    projectId: 'project_alpha',
    workerId: 'worker_alpha',
    reportId: 'report_ready',
    state: 'ready',
    summaryDigest: 'sha256_summary_ready',
  });
  assert.equal(reported.workers[0]?.state, 'reporting');
  assert.equal(reported.reports[0]?.state, 'ready');
  assert.equal(reported.events.at(-1)?.type, 'organization.report_recorded');
});

test('delegation only inherits contracted authority', () => {
  const opened = openProject(createOrganization('conversation_main'));
  const parent = createWorker(opened);
  const authorized = action(parent, {
    type: 'authorize_worker',
    projectId: 'project_alpha',
    workerId: 'worker_alpha',
  });

  assert.throws(
    () =>
      createWorker(authorized, {
        workerId: 'worker_child',
        delegationId: 'delegation_child',
        parentDelegationId: 'delegation_alpha',
        scope: ['project:beta'],
      }),
    /subset of parent authority/,
  );

  const child = createWorker(authorized, {
    workerId: 'worker_child',
    delegationId: 'delegation_child',
    parentDelegationId: 'delegation_alpha',
    agentRevisionId: 'agent_revision_child',
    displayName: 'Child Worker',
    instructionsDigest: 'sha256_instructions_child',
    scope: ['project:alpha'],
    capabilities: ['cap_read_context'],
    maxDelegationDepth: 1,
    ttlEvents: 50,
  });
  assert.equal(child.delegations.length, 2);
  assert.equal(child.delegations[1]?.parentDelegationId, 'delegation_alpha');
});

test('attention requests are structured and have explicit decisions', () => {
  const opened = openProject(createOrganization('conversation_main'));
  const proposed = createWorker(opened);
  const authorized = action(proposed, {
    type: 'authorize_worker',
    projectId: 'project_alpha',
    workerId: 'worker_alpha',
  });
  const started = action(authorized, {
    type: 'start_worker',
    projectId: 'project_alpha',
    workerId: 'worker_alpha',
  });
  const blocked = action(started, {
    type: 'report_worker',
    projectId: 'project_alpha',
    workerId: 'worker_alpha',
    reportId: 'report_blocked',
    state: 'blocked',
    summaryDigest: 'sha256_summary_blocked',
  });
  const requested = action(blocked, {
    type: 'request_attention',
    projectId: 'project_alpha',
    workerId: 'worker_alpha',
    attentionId: 'attention_one',
    questionDigest: 'sha256_question_one',
  });
  assert.equal(requested.attentionRequests[0]?.state, 'open');

  const answered = action(requested, {
    type: 'answer_attention',
    projectId: 'project_alpha',
    attentionId: 'attention_one',
    decisionDigest: 'sha256_answer_one',
  });
  assert.equal(answered.attentionRequests[0]?.state, 'answered');
  assert.equal(answered.events.at(-1)?.type, 'organization.attention_answered');
});

test('archive, offboard, and resume preserve history and require revalidation', () => {
  const opened = openProject(createOrganization('conversation_main'));
  const active = action(opened, {
    type: 'activate_project',
    projectId: 'project_alpha',
  });
  const proposed = createWorker(active);
  const authorized = action(proposed, {
    type: 'authorize_worker',
    projectId: 'project_alpha',
    workerId: 'worker_alpha',
  });
  const offboarded = action(authorized, {
    type: 'offboard_worker',
    projectId: 'project_alpha',
    workerId: 'worker_alpha',
  });
  assert.equal(offboarded.workers[0]?.state, 'offboarded');
  assert.equal(offboarded.delegations[0]?.state, 'revoked');

  const quiet = action(offboarded, {
    type: 'quiet_project',
    projectId: 'project_alpha',
  });
  const archived = action(quiet, {
    type: 'archive_project',
    projectId: 'project_alpha',
  });
  assert.equal(archived.projects[0]?.state, 'archived');

  const withDelegation = Object.freeze({
    ...archived,
    delegations: Object.freeze([
      Object.freeze({ ...archived.delegations[0]!, state: 'active' as const }),
    ]),
  });
  const resumed = action(withDelegation, {
    type: 'resume_project',
    projectId: 'project_alpha',
    revalidatedDelegationId: 'delegation_alpha',
  });
  assert.equal(resumed.projects[0]?.state, 'resumed');
  assert.ok(resumed.events.length > archived.events.length);
});

test('kernel rejects unknown fields, secret-like inputs, and stale sequences', () => {
  assert.throws(
    () =>
      parseOrganizationAction({
        type: 'open_project',
        expectedSequence: 0,
        projectId: 'project_alpha',
        originTriggerId: 'trigger_one',
        apiKey: 'should-not-exist',
      }),
    OrganizationValidationError,
  );

  assert.throws(
    () =>
      parseOrganizationAction({
        type: 'open_project',
        expectedSequence: 0,
        projectId: 'project_alpha',
        originTriggerId: 'sk-test-secret',
      }),
    OrganizationValidationError,
  );

  const opened = openProject(createOrganization('conversation_main'));
  assert.throws(
    () =>
      applyOrganizationAction(opened, {
        type: 'open_project',
        expectedSequence: 99,
        projectId: 'project_second',
        originTriggerId: 'trigger_two',
      }),
    OrganizationConflictError,
  );
});

test('serialized organization state and events contain only bounded references', () => {
  const opened = openProject(createOrganization('conversation_main'));
  const proposed = createWorker(opened, {
    instructionsDigest: 'sha256_private_instructions',
  });
  const serialized = JSON.stringify(proposed);
  assert.match(serialized, /sha256_private_instructions/);
  assert.doesNotMatch(serialized, /Bearer|sk-|password|apiKey|privateKey/);
  for (const event of proposed.events) {
    assert.deepEqual(
      Object.values(event.data).every((value) => ['string', 'number', 'boolean'].includes(typeof value)),
      true,
    );
  }
});
