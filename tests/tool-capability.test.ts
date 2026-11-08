import assert from 'node:assert/strict';
import test from 'node:test';
import { createConfigurationRevisionStore } from '../src/runtime/configuration-revision.js';
import {
  ToolAuditDeniedError,
  ToolCapabilityKernel,
  ToolExecutionRejectedError,
  ToolExecutorFailedError,
  ToolRegistrationError,
  ToolRegistry,
  toolArgumentsDigest,
  type ToolApprovalRecord,
  type ToolArguments,
  type ToolDefinition,
  type ToolExecutionRequest,
} from '../src/runtime/tool-capability.js';

const revision = createConfigurationRevisionStore({
  profile: ['tool-capability-kernel'],
  skills: [],
  policies: ['explicit-approval'],
  mcpServers: [],
}).active;

const SECRET_MARKER = 'fixture-secret-never-audited';
const requestArgs: ToolArguments = Object.freeze({ path: '/fixture' });

function definitions(): readonly ToolDefinition[] {
  return [
    {
      name: 'read_fixture',
      sideEffect: 'read',
      requiresApproval: false,
      argumentKeys: ['path'],
      execute: () => 'fixture result',
    },
    {
      name: 'write_fixture',
      sideEffect: 'write',
      requiresApproval: true,
      argumentKeys: ['path'],
      execute: () => 'fixture write',
    },
  ];
}

function approval(overrides: Partial<ToolApprovalRecord> = {}): ToolApprovalRecord {
  return {
    version: 1,
    id: 'approval_fixture',
    taskId: 'task_fixture',
    attempt: 1,
    toolName: 'write_fixture',
    argumentsDigest: digestFor(requestArgs),
    decision: 'approved',
    reason: 'deterministic fixture',
    createdAt: '2026-11-08T00:00:00.000Z',
    ...overrides,
  };
}

function digestFor(args: ToolArguments): string {
  return toolArgumentsDigest(args);
}

function request(overrides: Partial<ToolExecutionRequest> = {}): ToolExecutionRequest {
  return {
    taskId: 'task_fixture',
    attempt: 1,
    configurationRevisionId: revision.id,
    toolName: 'read_fixture',
    args: requestArgs,
    ...overrides,
  };
}

test('registry rejects duplicates, invalid names, and overlapping policy sets', () => {
  assert.throws(
    () => new ToolRegistry([...definitions(), definitions()[0]!]),
    ToolRegistrationError,
  );
  assert.throws(
    () => new ToolRegistry([{ ...definitions()[0]!, name: 'Invalid Name' }]),
    ToolRegistrationError,
  );
  const registry = new ToolRegistry(definitions());
  assert.deepEqual(registry.list().map((entry) => entry.name), [
    'read_fixture',
    'write_fixture',
  ]);
  assert.deepEqual(registry.policy, {
    allowedTools: ['read_fixture'],
    approvalRequiredTools: ['write_fixture'],
  });
});

test('an allowed tool executes once and replays without a second side effect', () => {
  let executions = 0;
  const registry = new ToolRegistry([{
    ...definitions()[0]!,
    execute: () => {
      executions += 1;
      return SECRET_MARKER;
    },
  }]);
  const kernel = new ToolCapabilityKernel({ registry });
  const first = kernel.execute(request());
  const replay = kernel.execute(request());

  assert.equal(executions, 1);
  assert.equal(first.record.executed, true);
  assert.equal(first.record.replayed, false);
  assert.equal(first.record.failureDigest, null);
  assert.equal(replay.record.executed, false);
  assert.equal(replay.record.replayed, true);
  assert.equal(replay.record.idempotencyKey, first.record.idempotencyKey);
  assert.deepEqual(first.events.map((event) => event.type), [
    'tool.requested',
    'tool.executed',
  ]);
  assert.deepEqual(replay.events.map((event) => event.type), [
    'tool.requested',
    'tool.replayed',
  ]);
  assert.equal(JSON.stringify(first.events).includes(SECRET_MARKER), false);
  assert.equal(JSON.stringify(replay.events).includes(SECRET_MARKER), false);
});

test('approval-required tools require an exact approval record', () => {
  let executions = 0;
  const registry = new ToolRegistry([{
    ...definitions()[1]!,
    execute: () => {
      executions += 1;
      return 'written';
    },
  }]);
  const kernel = new ToolCapabilityKernel({ registry });
  const base = request({ toolName: 'write_fixture' });

  assert.throws(
    () => kernel.execute(base),
    (error: unknown) => error instanceof ToolAuditDeniedError
      && error.decision === 'approval_required',
  );
  assert.equal(executions, 0);

  assert.throws(
    () => kernel.execute({ ...base, approval: approval({ decision: 'rejected' }) }),
    ToolAuditDeniedError,
  );
  assert.throws(
    () => kernel.execute({ ...base, approval: approval({ attempt: 2 }) }),
    ToolAuditDeniedError,
  );
  assert.throws(
    () => kernel.execute({
      ...base,
      args: { path: '/other' },
      approval: approval(),
    }),
    ToolAuditDeniedError,
  );
  assert.equal(executions, 0);

  const approved = kernel.execute({ ...base, approval: approval() });
  assert.equal(executions, 1);
  assert.equal(approved.record.executed, true);
  assert.equal(approved.record.failureDigest, null);
  assert.deepEqual(approved.events.map((event) => event.type), [
    'tool.requested',
    'tool.approval_required',
    'tool.approved',
    'tool.executed',
  ]);
});

test('rejections expose ordered audit events without unbounded approval identifiers', () => {
  const registry = new ToolRegistry(definitions());
  const kernel = new ToolCapabilityKernel({ registry });
  const rejected = request({ toolName: 'write_fixture' });

  let result: ToolExecutionRejectedError | null = null;
  try {
    kernel.execute({
      ...rejected,
      approval: approval({
        id: SECRET_MARKER,
        decision: 'rejected',
        reason: SECRET_MARKER,
      }),
    });
  } catch (cause) {
    assert.ok(cause instanceof ToolExecutionRejectedError);
    result = cause;
  }

  assert.ok(result);
  assert.deepEqual(result.events.map((event) => event.type), [
    'tool.requested',
    'tool.approval_required',
    'tool.rejected',
    'tool.denied',
  ]);
  assert.equal(JSON.stringify(result.events).includes(SECRET_MARKER), false);
  assert.ok(result.events.every((event) => Object.values(event.data).every((value) => (
    value === null || typeof value !== 'string' || value.length <= 64
  ))));
});

test('policy-denial errors also expose their audit events', () => {
  const registry = new ToolRegistry(definitions());
  const kernel = new ToolCapabilityKernel({ registry });

  let denial: ToolAuditDeniedError | null = null;
  try {
    kernel.execute(request({ toolName: 'write_fixture' }));
  } catch (cause) {
    assert.ok(cause instanceof ToolAuditDeniedError);
    denial = cause;
  }

  assert.ok(denial);
  assert.equal(denial.decision, 'approval_required');
  assert.deepEqual(denial.events.map((event) => event.type), [
    'tool.requested',
    'tool.approval_required',
    'tool.rejected',
    'tool.denied',
  ]);
});

test('denied and invalid requests never invoke an executor', () => {
  let executions = 0;
  const registry = new ToolRegistry([{
    ...definitions()[0]!,
    execute: () => {
      executions += 1;
      return 'unreachable';
    },
  }]);
  const kernel = new ToolCapabilityKernel({ registry });

  assert.throws(
    () => kernel.execute(request({ toolName: 'unknown_tool' })),
    ToolAuditDeniedError,
  );
  assert.throws(
    () => kernel.execute(request({ args: { unexpected: 'value' } })),
    ToolExecutionRejectedError,
  );
  assert.equal(executions, 0);
});

test('a new attempt uses a distinct idempotency key', () => {
  const registry = new ToolRegistry(definitions());
  const kernel = new ToolCapabilityKernel({ registry });
  const first = kernel.execute(request());
  const second = kernel.execute(request({ attempt: 2 }));

  assert.notEqual(first.record.idempotencyKey, second.record.idempotencyKey);
  assert.equal(second.record.executed, true);
  assert.equal(second.record.replayed, false);
});

test('an executor failure becomes a replayable normalized audit outcome', () => {
  let executions = 0;
  const registry = new ToolRegistry([{
    ...definitions()[0]!,
    execute: () => {
      executions += 1;
      throw new Error(SECRET_MARKER);
    },
  }]);
  const kernel = new ToolCapabilityKernel({ registry });

  let failed: ToolExecutorFailedError | null = null;
  try {
    kernel.execute(request());
  } catch (cause) {
    assert.ok(cause instanceof ToolExecutorFailedError);
    failed = cause;
  }
  assert.ok(failed);
  assert.deepEqual(failed.events.map((event) => event.type), [
    'tool.requested',
    'tool.failed',
  ]);

  let replayError: ToolExecutorFailedError | null = null;
  try {
    kernel.execute(request());
  } catch (cause) {
    assert.ok(cause instanceof ToolExecutorFailedError);
    replayError = cause;
  }
  assert.ok(replayError);
  assert.equal(executions, 1);
  assert.deepEqual(replayError.events.map((event) => event.type), [
    'tool.requested',
    'tool.replayed',
    'tool.failed',
  ]);
  assert.equal(JSON.stringify(replayError.events).includes(SECRET_MARKER), false);
});
