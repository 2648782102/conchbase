import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { registerOrganizationRoutes } from '../src/http/routes/v1/organization.js';
import { InMemoryOrganizationStore } from '../src/runtime/organization-store.js';

/** The published work-item list explains scheduled holds on a refresh. */
function fixture() {
  const app = Fastify({ logger: false });
  const store = new InMemoryOrganizationStore();
  store.initialize('boss_1');
  store.apply({ type: 'open_project', expectedSequence: 0, projectId: 'project_a', originTriggerId: 'int_a' });
  store.apply({ type: 'activate_project', expectedSequence: 1, projectId: 'project_a' });
  for (const workerId of ['wrk_one', 'wrk_two', 'wrk_three']) {
    store.apply({
      type: 'create_agent', expectedSequence: store.get().events.length,
      projectId: 'project_a', workerId, delegationId: `del_${workerId}`,
      agentRevisionId: `agr_${workerId}`, displayName: workerId,
      instructionsDigest: 'sha256:x', scope: ['project:a'], capabilities: ['cap_read_context'],
      model: { providerId: 'magpie', modelId: 'm' }, maxDelegationDepth: 0, ttlEvents: 10,
    });
    store.apply({
      type: 'authorize_worker', expectedSequence: store.get().events.length,
      projectId: 'project_a', workerId,
    });
  }
  registerOrganizationRoutes(app, store);
  return { app, store };
}

test('work-items list includes heldBy for work blocked by project capacity', async () => {
  const { app } = fixture();
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/organization/work-items' });
    assert.equal(response.statusCode, 200);
    const items = response.json<{ workItems: readonly {
      workItemId: string;
      state: string;
      heldBy?: string;
    }[] }>().workItems;
    assert.equal(items.length, 3);
    // Default per-project capacity is 2, so the third authorized worker is held.
    assert.equal(items.filter((item) => item.heldBy === 'project-limit').length, 1);
    assert.equal(items.filter((item) => item.heldBy === undefined).length, 2);
  } finally {
    await app.close();
  }
});
