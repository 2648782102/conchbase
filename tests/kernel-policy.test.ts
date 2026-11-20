import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PERMISSION_LEVELS,
  approvalRequired,
  decidePolicy,
  isPermissionLevel,
  scopeToolSet,
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

/**
 * Parameterised on purpose: this is the invariant a level must never be able to
 * break, so a level added later is covered automatically instead of needing
 * someone to remember to extend the test.
 */
test('no level can waive the pinned grant list', () => {
  for (const level of PERMISSION_LEVELS) {
    for (const effect of EFFECTS) {
      const outcome = decidePolicy(request({ level, effect, granted: false }));
      assert.equal(outcome.decision, 'deny', `${level}/${effect} must deny an ungranted action`);
      assert.match(outcome.reason, /not granted/);
    }
  }
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

test('trusted runs without approval', () => {
  for (const effect of EFFECTS) {
    const outcome = decidePolicy(request({ level: 'trusted', effect }));
    assert.equal(outcome.decision, 'allow', `trusted/${effect} should not require approval`);
    assert.equal(outcome.requiresApproval, false);
  }
});

test('every level and effect maps to exactly one decision', () => {
  for (const level of PERMISSION_LEVELS) {
    for (const effect of EFFECTS) {
      const decision = decidePolicy(request({ level, effect })).decision;
      assert.ok(['allow', 'approve', 'deny'].includes(decision));
      // Grant enforcement is unconditional, so an ungranted action must be
      // denied at every level — asserted here rather than via a flag that only
      // tests could call.
      assert.equal(
        decidePolicy(request({ level, effect, granted: false })).decision,
        'deny',
        `${level}/${effect} must deny an ungranted action`,
      );
      assert.equal(
        approvalRequired(level, effect),
        decision === 'approve',
        `${level}/${effect} approval flag must match the decision`,
      );
    }
  }
});

test('the level list has exactly three values', () => {
  assert.deepEqual([...PERMISSION_LEVELS], ['strict', 'standard', 'trusted']);
});

test('the reason never carries arguments or file contents', () => {
  const outcome = decidePolicy(request({ level: 'standard', effect: 'write' }));
  assert.ok(outcome.reason.length <= 64);
  assert.doesNotMatch(outcome.reason, /[{}\n]/);
});

test('permission level parsing rejects unknown strings', () => {
  for (const level of PERMISSION_LEVELS) assert.equal(isPermissionLevel(level), true);
  for (const bad of ['', 'admin', 'UNBOUNDED', 'unbounded', null, 1, undefined]) {
    assert.equal(isPermissionLevel(bad), false);
  }
});

/**
 * Scope belongs to the kernel too.
 *
 * "May this Agent use this tool" was answered in `capability-grants.ts` while
 * "must a human approve it" was answered here, so permission had two owners —
 * the same shape that produced the MCP default-to-read bug and the `unbounded`
 * waiver.
 */
test('scope keeps only granted tools and cannot widen the registered set', () => {
  const registered = ['workspace_read', 'workspace_write', 'git_status'];
  assert.deepEqual(
    scopeToolSet({ tools: registered }, [{ kind: 'tool', name: 'workspace_read' }]).allowed,
    ['workspace_read'],
  );
  // A grant for something the Runtime does not register is inert, never an error.
  assert.deepEqual(
    scopeToolSet({ tools: registered }, [{ kind: 'tool', name: 'not_registered' }]).allowed,
    [],
  );
  // Naming everything grants nothing beyond what exists.
  assert.deepEqual(
    scopeToolSet({ tools: registered }, registered.map((name) => ({ kind: 'tool' as const, name }))).allowed,
    registered,
  );
});

test('scope reports requested names that are unavailable, so a typo is visible', () => {
  const result = scopeToolSet({ tools: ['workspace_read'] }, [
    { kind: 'tool', name: 'workspace_read' },
    { kind: 'tool', name: 'misspelled_tool' },
  ]);
  assert.deepEqual(result.unavailable, ['misspelled_tool']);
});

test('skills are scoped by the same rule as tools', () => {
  const result = scopeToolSet({ tools: ['workspace_read'], skills: ['review'] }, [
    { kind: 'skill', name: 'review' },
  ]);
  assert.deepEqual(result.allowed, []);
  assert.deepEqual(result.skills, ['review']);
});

test('a grant of one kind never authorizes the other, even with the same name', () => {
  // A skill called `review` and a tool called `review` are different things.
  const result = scopeToolSet({ tools: ['review'], skills: ['review'] }, [
    { kind: 'skill', name: 'review' },
  ]);
  assert.deepEqual(result.allowed, [], 'the skill grant must not authorize the tool');
  assert.deepEqual(result.skills, ['review']);
});
