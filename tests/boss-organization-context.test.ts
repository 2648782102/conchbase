import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBossOrganizationFacts } from '../src/runtime/boss-organization-context.js';
import { InMemoryOrganizationStore } from '../src/runtime/organization-store.js';
import { parseOrganizationAction } from '../src/runtime/organization-contract.js';

test('boss organization facts project readable project purpose, workers, reports, and capability manifest', () => {
  const store = new InMemoryOrganizationStore();
  let sequence = 0;
  for (const action of [
    {
      type: 'open_project', expectedSequence: sequence++, projectId: 'project_alpha',
      originTriggerId: 'int_alpha',
    },
    { type: 'activate_project', expectedSequence: sequence++, projectId: 'project_alpha' },
    {
      type: 'create_agent', expectedSequence: sequence++, projectId: 'project_alpha',
      workerId: 'wrk_validator', delegationId: 'del_validator', agentRevisionId: 'agr_validator',
      displayName: '校验员', instructionsDigest: 'sha256_digest', scope: ['project:alpha'],
      capabilities: ['cap_read_context'], model: { providerId: 'magpie', modelId: 'fixture/model' },
      maxDelegationDepth: 0, ttlEvents: 100,
    },
    { type: 'authorize_worker', expectedSequence: sequence++, projectId: 'project_alpha', workerId: 'wrk_validator' },
    { type: 'start_worker', expectedSequence: sequence++, projectId: 'project_alpha', workerId: 'wrk_validator' },
    {
      type: 'report_worker', expectedSequence: sequence++, projectId: 'project_alpha',
      workerId: 'wrk_validator', reportId: 'rpt_fixture', state: 'blocked',
      summaryDigest: 'sha256_summary',
    },
  ] as const) {
    store.apply(parseOrganizationAction(action));
  }
  const facts = buildBossOrganizationFacts({
    snapshot: store.get(),
    intentTexts: new Map([['int_alpha', '帮我整理海螺的发布文档']]),
    agentInstructions: () => '检查发布包',
  });
  assert.equal(facts.projects[0]?.purpose, '帮我整理海螺的发布文档');
  assert.equal(facts.workers[0]?.displayName, '校验员');
  assert.equal(facts.workers[0]?.instructions, '检查发布包');
  assert.equal(facts.workers[0]?.state, 'blocked');
  assert.equal(facts.reports[0]?.state, 'blocked');
  assert.equal(facts.capabilities.find((item) => item.id === 'external-web')?.available, false);
  assert.equal(facts.capabilities.find((item) => item.id === 'local-files')?.available, false);
});
