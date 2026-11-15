import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryOrganizationStore } from '../src/runtime/organization-store.js';
import {
  DEFAULT_CONVERGENCE_POLICY,
  ProjectConvergenceService,
  decideConvergence,
  planConvergence,
  summarizeProject,
} from '../src/runtime/organization-convergence.js';
import type { OrganizationSnapshot } from '../src/runtime/organization-contract.js';

function seedProject(store: InMemoryOrganizationStore): void {
  store.apply({
    type: 'open_project', expectedSequence: 0,
    projectId: 'project_alpha', originTriggerId: 'int_alpha',
  });
  store.apply({
    type: 'activate_project', expectedSequence: 1,
    projectId: 'project_alpha',
  });
  store.apply({
    type: 'create_agent',
    expectedSequence: 2,
    projectId: 'project_alpha',
    workerId: 'wrk_alpha',
    delegationId: 'del_alpha',
    agentRevisionId: 'agr_alpha',
    displayName: 'Alpha Worker',
    instructionsDigest: 'sha256:instructions',
    scope: ['project:alpha'],
    capabilities: ['cap_read_context'],
    model: { providerId: 'magpie', modelId: 'fixture-model' },
    maxDelegationDepth: 0,
    ttlEvents: 50,
  });
  store.apply({
    type: 'authorize_worker', expectedSequence: 3,
    projectId: 'project_alpha', workerId: 'wrk_alpha',
  });
  store.apply({
    type: 'start_worker', expectedSequence: 4,
    projectId: 'project_alpha', workerId: 'wrk_alpha',
  });
  store.apply({
    type: 'report_worker',
    expectedSequence: 5,
    projectId: 'project_alpha',
    workerId: 'wrk_alpha',
    reportId: 'rpt_alpha',
    state: 'ready',
    summaryDigest: 'sha256:summary',
  });
}

function snapshotOf(store: InMemoryOrganizationStore): OrganizationSnapshot {
  return store.get();
}

test('an active project with a running task is never converged', () => {
  const store = new InMemoryOrganizationStore();
  seedProject(store);
  const decision = decideConvergence(snapshotOf(store), 'project_alpha', {
    now: Date.now(),
    policy: DEFAULT_CONVERGENCE_POLICY,
    hasActiveWork: true,
  });
  assert.equal(decision.converge, false);
  assert.equal(decision.reason, 'active-work');
});

test('an open attention request blocks convergence by default', () => {
  const store = new InMemoryOrganizationStore();
  seedProject(store);
  store.apply({
    type: 'request_attention',
    expectedSequence: 6,
    projectId: 'project_alpha',
    workerId: 'wrk_alpha',
    attentionId: 'att_alpha',
    questionDigest: 'sha256:question',
  });
  const decision = decideConvergence(snapshotOf(store), 'project_alpha', {
    now: Date.now(),
    policy: DEFAULT_CONVERGENCE_POLICY,
  });
  assert.equal(decision.converge, false);
  assert.equal(decision.reason, 'open-attention');
});

test('an archived project is never converged twice', () => {
  const store = new InMemoryOrganizationStore();
  seedProject(store);
  store.apply({ type: 'quiet_project', expectedSequence: 6, projectId: 'project_alpha' });
  store.apply({
    type: 'offboard_worker', expectedSequence: 7,
    projectId: 'project_alpha', workerId: 'wrk_alpha',
  });
  store.apply({ type: 'archive_project', expectedSequence: 8, projectId: 'project_alpha' });
  const decision = decideConvergence(snapshotOf(store), 'project_alpha', {
    now: Date.now(),
    policy: DEFAULT_CONVERGENCE_POLICY,
  });
  assert.equal(decision.converge, false);
  assert.equal(decision.reason, 'not-active');
});

test('the plan offboards workers before quieting and archiving', () => {
  const store = new InMemoryOrganizationStore();
  seedProject(store);
  const plan = planConvergence(snapshotOf(store), 'project_alpha');
  assert.ok(plan);
  assert.deepEqual(plan!.actions.map((action) => action.type), [
    'offboard_worker',
    'quiet_project',
    'archive_project',
  ]);
  // The domain rejects archiving while a worker is active, so this order is a
  // correctness requirement, not presentation.
  for (const action of plan!.actions) store.apply(action);
  const snapshot = store.get();
  assert.equal(snapshot.projects.find((project) => project.id === 'project_alpha')?.state, 'archived');
  assert.equal(snapshot.workers.find((worker) => worker.id === 'wrk_alpha')?.state, 'offboarded');
  assert.equal(snapshot.reports.length, 1, 'history must be preserved');
});

test('a sweep converges an idle project exactly once', () => {
  const store = new InMemoryOrganizationStore();
  seedProject(store);
  let now = 1_000_000;
  const announcements: string[] = [];
  const offboarded: string[] = [];
  const service = new ProjectConvergenceService({
    store,
    policy: { idleAfterMs: 1_000, convergeWithOpenAttention: false },
    now: () => now,
    onWorkerOffboarded: (workerId) => { offboarded.push(workerId); },
    announce: (summary) => { announcements.push(summary); },
  });
  // First sweep arms the idle clock; nothing can be idle on first sight.
  assert.equal(service.sweep().converged.length, 0);
  now += 500;
  assert.equal(service.sweep().converged.length, 0);
  now += 2_000;
  const result = service.sweep();
  assert.equal(result.converged.length, 1);
  assert.equal(announcements.length, 1);
  assert.deepEqual(offboarded, ['wrk_alpha']);
  assert.equal(store.get().projects[0]?.state, 'archived');
  // A second sweep must be a no-op rather than a duplicate announcement.
  assert.equal(service.sweep().converged.length, 0);
  assert.equal(announcements.length, 1);
});

test('new activity resets the idle clock', () => {
  const store = new InMemoryOrganizationStore();
  seedProject(store);
  let now = 5_000_000;
  const service = new ProjectConvergenceService({
    store,
    policy: { idleAfterMs: 1_000, convergeWithOpenAttention: false },
    now: () => now,
  });
  service.sweep();
  now += 800;
  // A fresh report is observable activity: the project is not idle yet.
  store.apply({
    type: 'report_worker',
    expectedSequence: 6,
    projectId: 'project_alpha',
    workerId: 'wrk_alpha',
    reportId: 'rpt_alpha_2',
    state: 'ready',
    summaryDigest: 'sha256:summary-2',
  });
  assert.equal(service.sweep().converged.length, 0);
  now += 900;
  assert.equal(service.sweep().converged.length, 0, 'the clock restarted at the new report');
  now += 400;
  assert.equal(service.sweep().converged.length, 1);
});

test('the summary reports durable outcomes and hides missing bodies', () => {
  const store = new InMemoryOrganizationStore();
  seedProject(store);
  const summary = summarizeProject(store.get(), 'project_alpha', new Map([['rpt_alpha', '交付了 Alpha 报告']]));
  assert.match(summary, /1 名员工/);
  assert.match(summary, /交付了 Alpha 报告/);
  const withoutBodies = summarizeProject(store.get(), 'project_alpha');
  assert.match(withoutBodies, /汇报正文未保留/);
});
