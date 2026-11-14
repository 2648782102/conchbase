import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/http/create-app.js';
import { ControlledExecutionService } from '../src/runtime/controlled-execution.js';
import {
  IsolatedExecutionService,
  createIsolatedChildExecutor,
} from '../src/runtime/isolated-execution.js';

const digest = `sha256:${'a'.repeat(64)}`;
const destinationDigest = 'sha256:5171f8f3e1172a39059a36998e84b69b57553e0645fe8d34660f7b2347ac6e82';
const now = () => '2026-11-14T00:00:00.000Z';

function grantInput(operation: string) {
  return {
    capabilityId: 'cap_fake_observe',
    agentId: 'agt_alpha',
    agentRevisionId: 'agr_alpha',
    configurationRevisionId: 'cfg_alpha',
    delegationId: 'del_alpha',
    projectId: 'project_alpha',
    workItemId: 'work_alpha',
    assignmentId: 'asg_alpha',
    operation,
    destinationDigest,
    scope: ['project:alpha'],
    capabilities: ['cap_read_context'],
    expiresAtSequence: 100,
  };
}

function approvedExecution() {
  const execution = new ControlledExecutionService({ now, executor: { async execute() {
    return Object.freeze({
      outcome: 'succeeded' as const,
      resultDigest: digest,
      errorDigest: null,
    });
  } } });
  const grant = execution.createGrant(grantInput('hash'));
  const request = execution.createRequest({
    grantId: grant.id,
    expectedGrantVersion: grant.expectedVersion,
    operation: 'hash',
    argumentsDigest: digest,
    idempotencyKey: 'req-alpha',
  });
  return { execution, grant, request: execution.getRequest(request.id) };
}

async function approve(execution: ControlledExecutionService, requestId: string) {
  const request = execution.getRequest(requestId);
  return execution.decideRequest({
    requestId,
    expectedVersion: request.expectedVersion,
    decision: 'approved',
    reasonDigest: digest,
  });
}

test('run requires approved request and active grant, then executes an isolated child', async () => {
  const { execution, grant, request } = approvedExecution();
  const runs = new IsolatedExecutionService({
    host: execution,
    now,
    executor: createIsolatedChildExecutor(),
  });
  assert.throws(
    () => runs.createRun({
      requestId: request.id,
      expectedRequestVersion: request.expectedVersion,
      grantId: grant.id,
      operation: 'hash',
      argumentsDigest: digest,
      adapterId: 'adapter_isolated_local_v2',
      idempotencyKey: 'run-alpha',
    }),
    /not approved and completed/,
  );
  const approved = await approve(execution, request.id);
  const run = runs.createRun({
    requestId: approved.id,
    expectedRequestVersion: approved.expectedVersion,
    grantId: grant.id,
    operation: 'hash',
    argumentsDigest: digest,
    adapterId: 'adapter_isolated_local_v2',
    idempotencyKey: 'run-alpha',
  });
  assert.equal(run.state, 'queued');
  const replay = runs.createRun({
    requestId: approved.id,
    expectedRequestVersion: approved.expectedVersion,
    grantId: grant.id,
    operation: 'hash',
    argumentsDigest: digest,
    adapterId: 'adapter_isolated_local_v2',
    idempotencyKey: 'run-alpha',
  });
  assert.deepEqual(replay, run);
  const finished = await runs.startRun({ runId: run.id, expectedVersion: run.expectedVersion });
  assert.equal(finished.state, 'succeeded');
  assert.match(finished.resultDigest ?? '', /^sha256:[0-9a-f]{64}$/);
  assert.equal(finished.exitCode, 0);
  assert.doesNotMatch(JSON.stringify(finished), /sk-|Bearer|privateKey|runtime\.sqlite/);
});

test('stale versions, idempotency conflicts, cancel, and recovery are explicit', async () => {
  const { execution, grant, request } = approvedExecution();
  const approved = await approve(execution, request.id);
  const runs = new IsolatedExecutionService({
    host: execution,
    now,
    executor: { async execute() {
      return Object.freeze({
        exitCode: 1,
        workerPidDigest: null,
        result: Object.freeze({ ok: false, errorDigest: digest }),
      });
    } },
  });
  const run = runs.createRun({
    requestId: approved.id,
    expectedRequestVersion: approved.expectedVersion,
    grantId: grant.id,
    operation: 'hash',
    argumentsDigest: digest,
    adapterId: 'adapter_isolated_local_v2',
    idempotencyKey: 'run-beta',
  });
  assert.throws(
    () => runs.createRun({
      requestId: approved.id,
      expectedRequestVersion: approved.expectedVersion,
      grantId: grant.id,
      operation: 'hash',
      argumentsDigest: `sha256:${'b'.repeat(64)}`,
      adapterId: 'adapter_isolated_local_v2',
      idempotencyKey: 'run-beta',
    }),
    /idempotency key conflicts/,
  );
  assert.throws(
    () => runs.cancelRun({ runId: run.id, expectedVersion: 99 }),
    /expectedVersion is stale/,
  );
  const cancelled = runs.cancelRun({ runId: run.id, expectedVersion: run.expectedVersion });
  assert.equal(cancelled.state, 'cancelled');
  assert.throws(
    () => runs.recoverRun({ runId: cancelled.id, expectedVersion: cancelled.expectedVersion }),
    /Only interrupted or failed runs can recover/,
  );
  const failedRun = runs.createRun({
    requestId: approved.id,
    expectedRequestVersion: approved.expectedVersion,
    grantId: grant.id,
    operation: 'hash',
    argumentsDigest: `sha256:${'c'.repeat(64)}`,
    adapterId: 'adapter_isolated_local_v2',
    idempotencyKey: 'run-gamma',
  });
  const failed = await runs.startRun({
    runId: failedRun.id,
    expectedVersion: failedRun.expectedVersion,
  });
  assert.equal(failed.state, 'failed');
  const recovered = runs.recoverRun({
    runId: failed.id,
    expectedVersion: failed.expectedVersion,
  });
  assert.equal(recovered.state, 'queued');
  assert.equal(recovered.attempt, 2);
});

test('restart interrupts running runs and preserves event history', async () => {
  const { execution, grant, request } = approvedExecution();
  const approved = await approve(execution, request.id);
  const base = new IsolatedExecutionService({
    host: execution,
    now,
    executor: { async execute() {
      return Object.freeze({
        exitCode: 0,
        workerPidDigest: null,
        result: Object.freeze({ ok: true, resultDigest: digest }),
      });
    } },
  });
  const run = base.createRun({
    requestId: approved.id,
    expectedRequestVersion: approved.expectedVersion,
    grantId: grant.id,
    operation: 'hash',
    argumentsDigest: digest,
    adapterId: 'adapter_isolated_local_v2',
    idempotencyKey: 'run-restart',
  }).state;
  assert.equal(run, 'queued');
  const snapshot = base.get();
  const running = Object.freeze({
    ...snapshot.runs[0]!,
    state: 'running' as const,
  });
  const rebuilt = new IsolatedExecutionService({
    host: execution,
    now,
    executor: { async execute() {
      return Object.freeze({
        exitCode: 0,
        workerPidDigest: null,
        result: Object.freeze({ ok: true, resultDigest: digest }),
      });
    } },
    initialSnapshot: Object.freeze({ ...snapshot, runs: Object.freeze([running]) }),
  });
  assert.equal(rebuilt.get().runs[0]?.state, 'interrupted');
  assert.equal(rebuilt.get().events.some((event) => event.type === 'execution.run_interrupted'), true);
});

test('1.3.0 HTTP contract publishes run discovery, adapters, and no plaintext', async () => {
  const execution = new ControlledExecutionService({ now, executor: { async execute() {
    return Object.freeze({ outcome: 'succeeded' as const, resultDigest: digest, errorDigest: null });
  } } });
  const runs = new IsolatedExecutionService({
    host: execution,
    now,
    executor: { async execute() {
      return Object.freeze({
        exitCode: 0,
        workerPidDigest: null,
        result: Object.freeze({ ok: true, resultDigest: digest }),
      });
    } },
  });
  const app = createApp({ logger: false, executionService: execution, executionRunService: runs });
  try {
    const runtime = await app.inject({ method: 'GET', url: '/v1/runtime' });
    assert.equal(runtime.json().executionContract, '1.2.0');
    assert.equal(runtime.json().executionRunContract, '1.3.0');
    assert.equal(runtime.json().executionRunPaths, 8);
    const health = await app.inject({ method: 'GET', url: '/v1/execution/run-health' });
    assert.equal(health.statusCode, 200);
    assert.equal(health.json().paths.length, 8);
    const adapters = await app.inject({ method: 'GET', url: '/v1/execution/adapters' });
    assert.equal(adapters.statusCode, 200);
    assert.equal(adapters.json().adapters[0].network, 'forbidden');
    const events = await app.inject({ method: 'GET', url: '/v1/execution/runs/none/events' });
    assert.equal(events.statusCode, 404);
    assert.doesNotMatch(JSON.stringify(adapters.json()), /sk-|Bearer|privateKey|runtime\.sqlite/);
  } finally {
    await app.close();
  }
});
