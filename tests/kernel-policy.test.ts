import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PERMISSION_LEVELS,
  approvalRequired,
  decidePolicy,
  grantEnforced,
  isPermissionLevel,
  type ActionEffect,
  type PermissionLevel,
  type PolicyRequest,
} from '../src/kernel/policy.js';

const EFFECTS: readonly ActionEffect[] = ['read', 'write', 'external'];

function request(overrides: Partial<PolicyRequest> = {}): PolicyRequest {
  return {
    level: 'standard',
    action: 'workspace_read',
    effect: 'read',
    granted: true,
    withinBoundary: true,
    ...overrides,
  };
}

test('a boundary violation is denied at every level', () => {
  for (const level of PERMISSION_LEVELS) {
    for (const effect of EFFECTS) {
      const outcome = decidePolicy(request({ level, effect, withinBoundary: false }));
      assert.equal(outcome.decision, 'deny', `${level}/${effect} must deny outside the boundary`);
      assert.equal(outcome.requiresApproval, false);
    }
  }
});

test('a missing grant is denied below unbounded, and allowed-to-run at unbounded', () => {
  for (const level of ['strict', 'standard', 'trusted'] as PermissionLevel[]) {
    for (const effect of EFFECTS) {
      const outcome = decidePolicy(request({ level, effect, granted: false }));
      assert.equal(outcome.decision, 'deny', `${level}/${effect} must deny an ungranted action`);
      assert.match(outcome.reason, /not granted/);
    }
  }
  // unbounded waives the grant list, but approval still follows the matrix.
  const unbounded = decidePolicy(request({ level: 'unbounded', effect: 'write', granted: false }));
  assert.equal(unbounded.decision, 'allow');
});

test('strict asks a human even for reads', () => {
  for (const effect of EFFECTS) {
    const outcome = decidePolicy(request({ level: 'strict', effect }));
    assert.equal(outcome.decision, 'approve', `strict must confirm ${effect}`);
    assert.equal(outcome.requiresApproval, true);
  }
});

test('standard confirms writes and external calls but not reads', () => {
  assert.equal(decidePolicy(request({ effect: 'read' })).decision, 'allow');
  assert.equal(decidePolicy(request({ effect: 'write' })).decision, 'approve');
  assert.equal(decidePolicy(request({ effect: 'external' })).decision, 'approve');
});

test('trusted and unbounded run without approval', () => {
  for (const level of ['trusted', 'unbounded'] as PermissionLevel[]) {
    for (const effect of EFFECTS) {
      const outcome = decidePolicy(request({ level, effect }));
      assert.equal(outcome.decision, 'allow', `${level}/${effect} should not require approval`);
      assert.equal(outcome.requiresApproval, false);
    }
  }
});

test('every level and effect maps to exactly one decision', () => {
  for (const level of PERMISSION_LEVELS) {
    for (const effect of EFFECTS) {
      const decision = decidePolicy(request({ level, effect })).decision;
      assert.ok(['allow', 'approve', 'deny'].includes(decision));
      assert.equal(grantEnforced(level), level !== 'unbounded');
      assert.equal(
        approvalRequired(level, effect),
        decision === 'approve',
        `${level}/${effect} approval flag must match the decision`,
      );
    }
  }
});

test('only unbounded waives the grant list', () => {
  assert.deepEqual(
    PERMISSION_LEVELS.filter((level) => !grantEnforced(level)),
    ['unbounded'],
  );
});

test('the reason never carries arguments or file contents', () => {
  const outcome = decidePolicy(request({ level: 'standard', effect: 'write' }));
  assert.ok(outcome.reason.length <= 64);
  assert.doesNotMatch(outcome.reason, /[{}\n]/);
});

test('permission level parsing rejects unknown strings', () => {
  for (const level of PERMISSION_LEVELS) assert.equal(isPermissionLevel(level), true);
  for (const bad of ['', 'admin', 'UNBOUNDED', null, 1, undefined]) {
    assert.equal(isPermissionLevel(bad), false);
  }
});
