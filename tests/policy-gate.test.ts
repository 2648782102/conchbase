import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ToolExecutionDeniedError,
  decideToolPolicy,
  executeToolThroughGate,
  type ToolPolicy,
} from '../src/runtime/policy-gate.js';
import {
  FAKE_SECRET_MARKER,
  mutableApprovalSource,
} from './fixtures/runtime-fixtures.js';

const POLICY: ToolPolicy = {
  allowedTools: ['read_file'],
  approvalRequiredTools: ['write_file'],
};

test('allowed tools execute through the policy gate', () => {
  let executions = 0;

  const result = executeToolThroughGate(
    POLICY,
    { toolName: 'read_file', approved: false },
    (toolName) => {
      executions += 1;
      return toolName;
    },
  );

  assert.equal(result.executed, true);
  assert.equal(result.result, 'read_file');
  assert.equal(executions, 1);
});

test('denied tools never execute', () => {
  let executions = 0;

  assert.throws(
    () => executeToolThroughGate(
      POLICY,
      { toolName: 'delete_file', approved: true },
      () => { executions += 1; },
    ),
    (error: unknown) => error instanceof ToolExecutionDeniedError
      && error.decision === 'denied',
  );
  assert.equal(executions, 0);
});

test('approval-required tools wait for an explicit approval', () => {
  let executions = 0;
  const execute = () => { executions += 1; };

  assert.equal(decideToolPolicy(POLICY, { toolName: 'write_file' }), 'approval_required');
  assert.throws(
    () => executeToolThroughGate(
      POLICY,
      { toolName: 'write_file', approved: false },
      execute,
    ),
    ToolExecutionDeniedError,
  );
  assert.equal(executions, 0);

  executeToolThroughGate(
    POLICY,
    { toolName: 'write_file', approved: true },
    execute,
  );
  assert.equal(executions, 1);
});

test('denied, approval-required, revoked, and granted decisions use deterministic fixtures', () => {
  let executions = 0;
  const approvals = mutableApprovalSource(['write_file']);
  const execute = (toolName: string) => {
    executions += 1;
    return toolName;
  };

  assert.equal(decideToolPolicy(POLICY, { toolName: 'delete_file' }), 'denied');
  assert.throws(
    () => executeToolThroughGate(
      POLICY,
      { toolName: 'delete_file', approved: approvals.isApproved('delete_file') },
      execute,
    ),
    (error: unknown) => error instanceof ToolExecutionDeniedError
      && error.decision === 'denied',
  );

  assert.equal(decideToolPolicy(POLICY, { toolName: 'write_file' }), 'approval_required');
  approvals.revoke('write_file');
  assert.throws(
    () => executeToolThroughGate(
      POLICY,
      { toolName: 'write_file', approved: approvals.isApproved('write_file') },
      execute,
    ),
    (error: unknown) => error instanceof ToolExecutionDeniedError
      && error.decision === 'approval_required',
  );

  approvals.grant('write_file');
  const result = executeToolThroughGate(
    POLICY,
    { toolName: 'write_file', approved: approvals.isApproved('write_file') },
    execute,
  );

  assert.equal(result.decision, 'approval_required');
  assert.equal(result.executed, true);
  assert.equal(executions, 1);
});

test('policy errors and event-shaped fixtures do not serialize the fake secret', () => {
  let denial: unknown;
  try {
    executeToolThroughGate(
      POLICY,
      { toolName: 'delete_file', approved: false },
      () => FAKE_SECRET_MARKER,
    );
  } catch (error) {
    denial = error;
  }

  const serialized = JSON.stringify({
    denial: denial instanceof Error
      ? { name: denial.name, message: denial.message }
      : denial,
    events: [
      { type: 'task.queued', state: 'queued' },
      { type: 'task.failed', state: 'failed' },
    ],
    logs: ['policy denied delete_file'],
  });

  assert.equal(serialized.includes(FAKE_SECRET_MARKER), false);
});
