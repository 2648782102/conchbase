import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import Fastify from 'fastify';
import { createApp } from '../src/http/create-app.js';
import { ORGANIZATION_PATHS_FIXTURE } from './fixtures/runtime-fixtures.js';
import { InMemoryOrganizationStore } from '../src/runtime/organization-store.js';
import { registerOrganizationRoutes } from '../src/http/routes/v1/organization.js';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

function createFixture() {
  const app = Fastify({ logger: false });
  const store = new InMemoryOrganizationStore();
  store.apply({ type: 'open_project', expectedSequence: 0, projectId: 'project_alpha', originTriggerId: 'trigger_one' });
  store.apply({ type: 'activate_project', expectedSequence: 1, projectId: 'project_alpha' });
  registerOrganizationRoutes(app, store);
  return { app, store };
}

async function request(
  app: ReturnType<typeof createApp> | ReturnType<typeof Fastify>,
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
) {
  return app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { headers: { 'content-type': 'application/json' }, payload: JSON.stringify(payload) }),
  });
}

function attentionFixture(store: InMemoryOrganizationStore): string {
  store.apply({
    type: 'create_agent',
    expectedSequence: 2,
    projectId: 'project_alpha',
    workerId: 'worker_alpha',
    delegationId: 'delegation_alpha',
    agentRevisionId: 'agent_revision_alpha',
    displayName: 'Worker',
    instructionsDigest: 'sha256_instructions',
    scope: ['project:alpha'],
    capabilities: ['cap_read_context'],
    model: { providerId: 'local', modelId: 'test-model' },
    maxDelegationDepth: 0,
    ttlEvents: 50,
  });
  store.apply({ type: 'authorize_worker', expectedSequence: 3, projectId: 'project_alpha', workerId: 'worker_alpha' });
  store.apply({ type: 'start_worker', expectedSequence: 4, projectId: 'project_alpha', workerId: 'worker_alpha' });
  store.apply({
    type: 'report_worker',
    expectedSequence: 5,
    projectId: 'project_alpha',
    workerId: 'worker_alpha',
    reportId: 'report_alpha',
    state: 'blocked',
    summaryDigest: 'sha256_report',
  });
  store.apply({
    type: 'request_attention',
    expectedSequence: 6,
    projectId: 'project_alpha',
    workerId: 'worker_alpha',
    attentionId: 'attention_alpha',
    questionDigest: 'sha256_question',
  });
  return 'attention_alpha';
}

test('organization API publishes the exact additive path set and version discovery', async () => {
  const store = new InMemoryOrganizationStore();
  const app = createApp({
    logger: false,
    taskService: { store: { organization: store } } as never,
  });
  try {
    const runtime = await request(app, 'GET', '/v1/runtime');
    assert.equal(runtime.statusCode, 200);
    assert.equal(runtime.json().organizationContract, '1.1.0');
    assert.equal(runtime.json().organizationPaths, 18);

    const spec = readFileSync(path.join(repositoryRoot, 'docs/openapi.yaml'), 'utf8');
    const paths = [...spec.matchAll(/^ {2}(\/v1\/organization\/[^:]+):$/gm)].map((match) => match[1]);
    assert.deepEqual(paths, [...ORGANIZATION_PATHS_FIXTURE]);
  } finally {
    await app.close();
  }
});

test('organization intents accept once, replay idempotently, and reject secret-like text', async () => {
  const { app, store } = createFixture();
  try {
    const body = {
      intent: {
        text: 'Start planning project beta from the primary conversation.',
        idempotencyKey: 'fixture-intent-1',
        expectedSequence: 2,
      },
    };
    const accepted = await request(app, 'POST', '/v1/organization/session/intents', body);
    assert.equal(accepted.statusCode, 202);
    assert.equal(accepted.json().state, 'accepted');
    assert.equal(accepted.json().expectedSequence, 3);
    const replay = await request(app, 'POST', '/v1/organization/session/intents', body);
    assert.equal(replay.statusCode, 202);
    assert.deepEqual(replay.json(), accepted.json());
    assert.equal(store.get().events.length, 3);

    const conflict = await request(app, 'POST', '/v1/organization/session/intents', {
      ...body,
      intent: { ...body.intent, expectedSequence: 0 },
    });
    assert.equal(conflict.statusCode, 409);

    const secret = await request(app, 'POST', '/v1/organization/session/intents', {
      intent: { ...body.intent, idempotencyKey: 'fixture-intent-2', text: 'use sk-secret-value' },
    });
    assert.equal(secret.statusCode, 400);
  } finally {
    await app.close();
  }
});

test('organization reads, attention decisions, and events expose only bounded published facts', async () => {
  const { app, store } = createFixture();
  try {
    const attentionId = attentionFixture(store);
    const projects = await request(app, 'GET', '/v1/organization/projects');
    assert.equal(projects.statusCode, 200);
    assert.equal(projects.json().projects[0]?.id, 'project_alpha');

    const proposals = await request(app, 'GET', '/v1/organization/agents/proposals');
    assert.equal(proposals.statusCode, 200);
    assert.match(proposals.json().proposals[0].instructionsDigest, /^[a-z0-9_.:-]+$/);
    assert.doesNotMatch(JSON.stringify(proposals.json()), /"instructions"|Bearer|sk-|privateKey/);

    const attention = await request(app, 'GET', `/v1/organization/attention/${attentionId}`);
    assert.equal(attention.statusCode, 200);
    const expectedVersion = attention.json().attentionRequest.expectedVersion;

    const stale = await request(app, 'POST', `/v1/organization/attention/${attentionId}/answer`, {
      expectedVersion: 1,
      decisionDigest: 'sha256_decision',
    });
    assert.equal(stale.statusCode, 409);

    const answered = await request(app, 'POST', `/v1/organization/attention/${attentionId}/answer`, {
      expectedVersion,
      decisionDigest: 'sha256_decision',
    });
    assert.equal(answered.statusCode, 200);
    assert.equal(answered.json().attentionRequest.state, 'answered');

    const replayDecision = await request(app, 'POST', `/v1/organization/attention/${attentionId}/withdraw`, {
      expectedVersion,
      decisionDigest: 'sha256_decision',
    });
    assert.equal(replayDecision.statusCode, 409);

    const page = await request(app, 'GET', '/v1/organization/events?limit=2');
    assert.equal(page.statusCode, 200);
    assert.equal(page.json().events.length, 2);
    assert.equal(page.json().hasMore, true);
    assert.equal(page.json().events[1].expectedVersion, 2);

    const next = await request(app, 'GET', `/v1/organization/events?after=${page.json().nextCursor}&limit=2`);
    assert.equal(next.statusCode, 200);
    assert.equal(next.json().events[0].sequence, 3);
    const replayFromCursor = await request(app, 'GET', `/v1/organization/events?after=${page.json().nextCursor}`);
    assert.equal(replayFromCursor.statusCode, 200);
    assert.equal(replayFromCursor.json().events[0].sequence, 3);

    const unknown = await request(app, 'GET', '/v1/organization/events?after=evt_unknown');
    assert.equal(unknown.statusCode, 400);
    const overLimit = await request(app, 'GET', '/v1/organization/events?limit=1001');
    assert.equal(overLimit.statusCode, 400);

    const serialized = JSON.stringify([
      (await request(app, 'GET', '/v1/organization/session')).json(),
      page.json(),
    ]);
    assert.doesNotMatch(serialized, /\.conchbase|runtime\.sqlite|sk-|Bearer|privateKey/);
  } finally {
    await app.close();
  }
});

test('organization routes return 503 without an authoritative store', async () => {
  const app = Fastify();
  registerOrganizationRoutes(app, undefined);
  try {
    const response = await request(app, 'GET', '/v1/organization/session');
    assert.equal(response.statusCode, 503);
  } finally {
    await app.close();
  }
});
