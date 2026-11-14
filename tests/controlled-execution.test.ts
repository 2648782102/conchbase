import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/http/create-app.js';
import {
  ControlledExecutionService,
  ExecutionConflictError,
  ExecutionNotFoundError,
  createDeterministicFakeExecutor,
} from '../src/runtime/controlled-execution.js';

function digest(value: string): string {
  return `sha256:${'a'.repeat(64)}`;
}

const grantInput = {
  capabilityId: 'cap_fake_observe',
  agentId: 'agt_alpha',
  agentRevisionId: 'agr_alpha',
  configurationRevisionId: 'cfg_alpha',
  delegationId: 'del_alpha',
  projectId: 'project_alpha',
  workItemId: 'work_alpha',
  assignmentId: 'asg_alpha',
  operation: 'observe',
  destinationDigest: 'sha256:5171f8f3e1172a39059a36998e84b69b57553e0645fe8d34660f7b2347ac6e82',
  scope: ['project:alpha'],
  capabilities: ['cap_read_context'],
  expiresAtSequence: 100,
};

function service(): ControlledExecutionService {
  return new ControlledExecutionService({
    now: () => '2026-11-14T00:00:00.000Z',
    executor: createDeterministicFakeExecutor(),
  });
}

test('recorded capability metadata never grants execution by itself', () => {
  const execution = service();
  assert.equal(execution.get().capabilities[0]?.state, 'enabled');
  assert.equal(execution.get().grants.length, 0);
  assert.throws(
    () => execution.createRequest({
      grantId: 'xgt_missing',
      expectedGrantVersion: 1,
      operation: 'observe',
      argumentsDigest: digest('args'),
      idempotencyKey: 'idem-1',
    }),
    ExecutionNotFoundError,
  );
});

test('grant pins identity and revocation prevents new requests', () => {
  const execution = service();
  const grant = execution.createGrant(grantInput);
  assert.equal(grant.state, 'granted');
  assert.equal(grant.agentRevisionId, 'agr_alpha');
  assert.equal(grant.delegationId, 'del_alpha');
  assert.throws(() => execution.revokeGrant(grant.id, 99), ExecutionConflictError);
  const revoked = execution.revokeGrant(grant.id, grant.expectedVersion);
  assert.equal(revoked.state, 'revoked');
  assert.throws(
    () => execution.createRequest({
      grantId: grant.id,
      expectedGrantVersion: revoked.expectedVersion,
      operation: 'observe',
      argumentsDigest: digest('args'),
      idempotencyKey: 'idem-2',
    }),
    ExecutionConflictError,
  );
});

test('approved request fake-executes with digest-only result; rejected never executes', async () => {
  const execution = service();
  const grant = execution.createGrant(grantInput);
  const created = execution.createRequest({
    grantId: grant.id,
    expectedGrantVersion: grant.expectedVersion,
    operation: 'observe',
    argumentsDigest: digest('args'),
    idempotencyKey: 'idem-3',
  });
  assert.equal(created.state, 'pending');
  const succeeded = await execution.decideRequest({
    requestId: created.id,
    expectedVersion: created.expectedVersion,
    decision: 'approved',
    reasonDigest: digest('reason'),
  });
  assert.equal(succeeded.state, 'succeeded');
  assert.match(succeeded.resultDigest ?? '', /^sha256:[0-9a-f]{64}$/);
  assert.equal(succeeded.errorDigest, null);

  const rejectRequest = execution.createRequest({
    grantId: grant.id,
    expectedGrantVersion: grant.expectedVersion,
    operation: 'observe',
    argumentsDigest: digest('args-2'),
    idempotencyKey: 'idem-4',
  });
  const rejected = await execution.decideRequest({
    requestId: rejectRequest.id,
    expectedVersion: rejectRequest.expectedVersion,
    decision: 'rejected',
    reasonDigest: digest('deny'),
  });
  assert.equal(rejected.state, 'rejected');
  assert.equal(rejected.resultDigest, null);
});

test('execution HTTP contract exposes published paths, errors, and no plaintext', async () => {
  const app = createApp({ logger: false, executionService: service() });
  try {
    const runtime = await app.inject({ method: 'GET', url: '/v1/runtime' });
    assert.equal(runtime.json().executionContract, '1.2.0');
    assert.equal(runtime.json().executionPaths, 8);
    const health = await app.inject({ method: 'GET', url: '/v1/execution/health' });
    assert.equal(health.statusCode, 200);
    assert.equal(health.json().paths.length, 8);

    const grantResponse = await app.inject({
      method: 'POST',
      url: '/v1/execution/grants',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(grantInput),
    });
    assert.equal(grantResponse.statusCode, 201);
    const grant = grantResponse.json().grant;
    const requestResponse = await app.inject({
      method: 'POST',
      url: '/v1/execution/requests',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        grantId: grant.id,
        expectedGrantVersion: grant.expectedVersion,
        operation: 'observe',
        argumentsDigest: digest('args'),
        idempotencyKey: 'http-idem',
      }),
    });
    assert.equal(requestResponse.statusCode, 201);
    const executionRequest = requestResponse.json().request;
    const stale = await app.inject({
      method: 'POST',
      url: `/v1/execution/requests/${executionRequest.id}/decide`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        expectedVersion: 99,
        decision: 'approved',
        reasonDigest: digest('reason'),
      }),
    });
    assert.equal(stale.statusCode, 409);
    const decided = await app.inject({
      method: 'POST',
      url: `/v1/execution/requests/${executionRequest.id}/decide`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        expectedVersion: executionRequest.expectedVersion,
        decision: 'approved',
        reasonDigest: digest('reason'),
      }),
    });
    assert.equal(decided.statusCode, 200);
    assert.equal(decided.json().request.state, 'succeeded');
    const events = await app.inject({ method: 'GET', url: '/v1/execution/events' });
    assert.equal(events.statusCode, 200);
    assert.doesNotMatch(JSON.stringify(decided.json()), /sk-|Bearer|privateKey|runtime\.sqlite/);
    assert.doesNotMatch(JSON.stringify(events.json()), /sk-|Bearer|privateKey|runtime\.sqlite/);
  } finally {
    await app.close();
  }
});
