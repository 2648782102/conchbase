import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/http/create-app.js';
import { loadRuntimeConfig } from '../src/config/runtime-config.js';
import { rawSha256Digest } from '../src/runtime/platform-contract.js';
import { SqliteTaskStore } from '../src/runtime/task-store.js';

const FIXED_SECRET = 'fixture-secret-never-logged';
const digest = (value: string): string => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const now = '2026-11-11T00:00:00.000Z';

function triggerRequest(overrides: Record<string, unknown> = {}) {
  return {
    source: { sourceId: 'fake.inbox', kind: 'fake' },
    trigger: {
      triggerId: 'event-001',
      threadKey: 'thread-a',
      payloadDigest: digest('payload-a'),
      occurredAt: now,
    },
    mandate: {
      scope: ['read-local-fixture'],
      allowedOperations: ['observe'],
      capabilitiesDigest: digest('capabilities'),
    },
    model: { providerId: 'fake', modelId: 'fixture' },
    agentRevisionId: 'rev_fixture',
    configurationRevisionId: 'cfg_fixture',
    ...overrides,
  };
}

async function jsonRequest(
  app: ReturnType<typeof createApp>,
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
) {
  const options: Record<string, unknown> = { method, url };
  if (payload !== undefined) {
    options.headers = { 'content-type': 'application/json' };
    options.payload = JSON.stringify(payload);
  }
  return await app.inject(options);
}

async function withApp(action: (app: ReturnType<typeof createApp>, filename: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-platform-api-'));
  const filename = path.join(directory, 'runtime.sqlite');
  const store = new SqliteTaskStore(filename);
  const app = createApp({ logger: false, taskService: { store } as never });
  try {
    await action(app, filename);
  } finally {
    await app.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test('all published platform routes enforce exact bodies, identity, states, and no-leak responses', async () => {
  await withApp(async (app, filename) => {
    const created = await jsonRequest(app, 'POST', '/v1/work/triggers', triggerRequest());
    assert.equal(created.statusCode, 201);
    const workItemId = created.json<{ workItem: { id: string } }>().workItem.id;
    const detail = await jsonRequest(app, 'GET', `/v1/work/items/${workItemId}`);
    const assignmentId = detail.json<{ assignments: { id: string }[] }>().assignments[0]!.id;
    const receiptId = detail.json<{ deliveryReceipts: { id: string }[] }>().deliveryReceipts[0]!.id;

    const malformed = await app.inject({
      method: 'POST', url: '/v1/capabilities', headers: { 'content-type': 'application/json' }, payload: '{',
    });
    assert.equal(malformed.statusCode, 400);
    assert.equal((await jsonRequest(app, 'POST', '/v1/capabilities', {
      kind: 'mcp', name: 'fixture', status: 'enabled', descriptor: 'local', unexpected: true,
    })).statusCode, 400);
    assert.equal((await jsonRequest(app, 'POST', '/v1/work/items/work_unknown/start', { expectedState: 'open' })).statusCode, 404);

    const pairingResponse = await jsonRequest(app, 'POST', '/v1/auth/pairings', { label: 'client' });
    assert.equal(pairingResponse.statusCode, 201);
    const pairing = pairingResponse.json<{ pairing: { id: string; challengeDigest: string } }>().pairing;
    assert.equal((await jsonRequest(app, 'POST', '/v1/auth/pairings/approve', {
      pairingId: pairing.id, challengeDigest: digest('wrong'),
    })).statusCode, 409);
    assert.equal((await jsonRequest(app, 'POST', '/v1/auth/pairings/approve', {
      pairingId: pairing.id, challengeDigest: pairing.challengeDigest,
    })).statusCode, 200);
    const tokenResponse = await jsonRequest(app, 'POST', '/v1/auth/tokens', {
      pairingId: pairing.id, name: 'fixture', tokenDigest: rawSha256Digest('fixture-token'),
    });
    assert.equal(tokenResponse.statusCode, 201);
    const tokenId = tokenResponse.json<{ token: { id: string } }>().token.id;
    assert.equal((await jsonRequest(app, 'POST', `/v1/auth/tokens/${tokenId}/revoke`)).statusCode, 200);
    assert.equal((await jsonRequest(app, 'POST', `/v1/auth/pairings/${pairing.id}/revoke`)).statusCode, 200);
    assert.equal((await jsonRequest(app, 'POST', '/v1/auth/tokens', {
      pairingId: pairing.id, name: 'late', tokenDigest: rawSha256Digest('late'),
    })).statusCode, 409);

    const denied = await jsonRequest(app, 'POST', '/v1/sources/local/events', {
      sourceId: 'local', threadKey: 'thread-a', payloadDigest: digest('denied'),
      occurredAt: now, policy: 'deny', mandateDigest: digest('mandate'),
    });
    assert.equal(denied.statusCode, 201);
    const allowed = await jsonRequest(app, 'POST', '/v1/sources/local/events', {
      sourceId: 'local', threadKey: 'thread-a', payloadDigest: digest('allowed'),
      occurredAt: '2026-11-11T00:00:01.000Z', policy: 'allow', mandateDigest: digest('mandate'),
    });
    assert.equal(allowed.statusCode, 201);
    assert.equal((await jsonRequest(app, 'POST', `/v1/work/items/${workItemId}/start`, { expectedState: 'open' })).statusCode, 409);

    const capability = await jsonRequest(app, 'POST', '/v1/capabilities', {
      kind: 'skill', name: 'fixture-skill', status: 'enabled', descriptor: 'local descriptor',
    });
    assert.equal(capability.statusCode, 201);
    assert.equal((await jsonRequest(app, 'GET', '/v1/capabilities')).json<{ capabilities: unknown[] }>().capabilities.length, 1);

    const handleResponse = await jsonRequest(app, 'POST', '/v1/secret-handles', {
      key: 'fixture-key',
      value: FIXED_SECRET,
      purpose: 'fixture purpose',
      allowedAdapter: 'local-bound-fixture',
      destinationBinding: 'local-fixture',
    });
    assert.equal(handleResponse.statusCode, 201);
    const handleId = handleResponse.json<{ handle: { id: string } }>().handle.id;
    const useBody = {
      handleId, workItemId, assignmentId, grantRevision: 'grant_fixture',
    };
    const mismatch = await jsonRequest(app, 'POST', `/v1/secret-handles/${handleId}/use`, {
      ...useBody, handleId: 'sh_other',
    });
    assert.equal(mismatch.statusCode, 409);
    const used = await jsonRequest(app, 'POST', `/v1/secret-handles/${handleId}/use`, useBody);
    assert.equal(used.statusCode, 200);
    assert.equal(used.json<{ receipt: { outcome: string } }>().receipt.outcome, 'injected');
    assert.equal((await jsonRequest(app, 'POST', `/v1/secret-handles/${handleId}/rotate`, {
      value: 'rotated-value',
    })).statusCode, 200);
    assert.equal((await jsonRequest(app, 'POST', `/v1/secret-handles/${handleId}/status`, {
      status: 'disabled',
    })).statusCode, 200);
    assert.equal((await jsonRequest(app, 'POST', `/v1/secret-handles/${handleId}/use`, useBody))
      .json<{ receipt: { outcome: string } }>().receipt.outcome, 'denied');

    assert.equal((await jsonRequest(app, 'POST', `/v1/work/items/${workItemId}/stop`, { expectedState: 'running' })).statusCode, 200);
    assert.equal((await jsonRequest(app, 'POST', `/v1/work/delivery-receipts/${receiptId}/decision`, {
      decision: 'accepted',
    })).statusCode, 200);
    assert.equal((await jsonRequest(app, 'POST', `/v1/work/assignments/${assignmentId}/reconcile`, {
      outcome: 'succeeded',
    })).statusCode, 409);

    for (const url of [
      '/v1/auth/pairings', '/v1/auth/tokens', '/v1/sources/local/events',
      '/v1/capabilities', '/v1/secret-handles', '/v1/secret-handles/use-receipts', '/v1/work/events',
    ]) {
      const response = await jsonRequest(app, 'GET', url);
      assert.equal(response.statusCode, 200);
      assert.doesNotMatch(response.body, new RegExp(FIXED_SECRET));
    }
    const serializedResponses = JSON.stringify([
      pairingResponse.body, tokenResponse.body, capability.body, handleResponse.body, used.body,
      allowed.body, denied.body, (await jsonRequest(app, 'GET', '/v1/work/events')).body,
    ]);
    assert.doesNotMatch(serializedResponses, new RegExp(FIXED_SECRET));
    const bytes = readFileSync(filename);
    assert.equal(bytes.includes(Buffer.from(FIXED_SECRET, 'utf8')), false);
  });
});

test('non-loopback binding requires an approved bearer digest and never echoes the token', async () => {
  const token = 'fixture-approved-token';
  const config = loadRuntimeConfig({
    CONCHBASE_HOST: '192.168.1.10',
    CONCHBASE_ALLOW_AUTHENTICATED_REMOTE_BINDING: '1',
    CONCHBASE_AUTH_TOKEN_DIGEST: rawSha256Digest(token),
  });
  assert.equal(config.allowAuthenticatedRemoteBinding, true);
  assert.throws(() => loadRuntimeConfig({
    CONCHBASE_HOST: '192.168.1.10',
    CONCHBASE_ALLOW_AUTHENTICATED_REMOTE_BINDING: '1',
  }), /CONCHBASE_AUTH_TOKEN_DIGEST/);
  const app = createApp({ logger: false, config });
  try {
    const missing = await app.inject({ method: 'GET', url: '/v1/health' });
    assert.equal(missing.statusCode, 401);
    assert.doesNotMatch(missing.body, new RegExp(token));
    const approved = await app.inject({
      method: 'GET', url: '/v1/health', headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(approved.statusCode, 200);
    assert.doesNotMatch(approved.body, new RegExp(token));
  } finally {
    await app.close();
  }
});

test('unconfigured platform routes return 503 without platform state', async () => {
  const app = createApp({ logger: false });
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/capabilities' });
    assert.equal(response.statusCode, 503);
  } finally {
    await app.close();
  }
});
