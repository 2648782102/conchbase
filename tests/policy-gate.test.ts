import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ToolExecutionDeniedError,
  decideToolPolicy,
  executeToolThroughGate,
  type ToolPolicy,
} from '../src/runtime/policy-gate.js';

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
