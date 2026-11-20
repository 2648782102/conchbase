import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROCESS_LIMITS,
  ProcessSpecError,
  validateProcessSpec,
  type ProcessSpec,
} from '../src/kernel/process-spec.js';

const ROOT = '/tmp/conchbase-workspace';

function spec(overrides: Partial<ProcessSpec> = {}): ProcessSpec {
  return {
    command: '/usr/bin/node',
    args: ['script.js'],
    cwd: ROOT,
    envAllowlist: [],
    ...overrides,
  };
}

test('a valid spec is normalized with defaults', () => {
  const validated = validateProcessSpec(spec(), ROOT);
  assert.equal(validated.timeoutMs, PROCESS_LIMITS.defaultTimeoutMs);
  assert.equal(validated.killable, true);
  assert.deepEqual(validated.env, {});
});

test('a relative command is rejected', () => {
  assert.throws(() => validateProcessSpec(spec({ command: 'node' }), ROOT), ProcessSpecError);
});

test('a cwd outside the workspace is rejected at every depth', () => {
  for (const cwd of ['/tmp', '/tmp/conchbase-workspace-evil', '/etc']) {
    assert.throws(() => validateProcessSpec(spec({ cwd }), ROOT), /inside the workspace/);
  }
  // A nested directory is fine; the prefix match is path-aware, not string-aware.
  assert.doesNotThrow(() => validateProcessSpec(spec({ cwd: `${ROOT}/nested` }), ROOT));
});

test('only allowlisted variables are inherited', () => {
  const validated = validateProcessSpec(
    spec({ envAllowlist: ['PATH', 'HOME'] }),
    ROOT,
    { PATH: '/usr/bin', HOME: '/home/user', SECRET_TOKEN: 'leak' },
  );
  assert.deepEqual(validated.env, { PATH: '/usr/bin', HOME: '/home/user' });
  assert.equal('SECRET_TOKEN' in validated.env, false);
});

test('caller-supplied variables are bounded and validated', () => {
  const validated = validateProcessSpec(spec({ env: { EXPLICIT: 'value' } }), ROOT);
  assert.equal(validated.env.EXPLICIT, 'value');
  assert.throws(() => validateProcessSpec(spec({ env: { 'bad name': 'x' } }), ROOT), ProcessSpecError);
  const tooMany = Object.fromEntries(
    Array.from({ length: PROCESS_LIMITS.maxEnvEntries + 1 }, (_, index) => [`V${index}`, 'x']),
  );
  assert.throws(() => validateProcessSpec(spec({ env: tooMany }), ROOT), /at most/);
});

test('arguments and timeouts are bounded', () => {
  const tooMany = Array.from({ length: PROCESS_LIMITS.maxArgs + 1 }, () => 'a');
  assert.throws(() => validateProcessSpec(spec({ args: tooMany }), ROOT), /arguments/);
  assert.throws(() => validateProcessSpec(spec({ args: ['a\0b'] }), ROOT), ProcessSpecError);
  assert.throws(() => validateProcessSpec(spec({ timeoutMs: 0 }), ROOT), /timeout/);
  assert.throws(() => validateProcessSpec(spec({ timeoutMs: PROCESS_LIMITS.maxTimeoutMs + 1 }), ROOT), /timeout/);
  assert.equal(validateProcessSpec(spec({ timeoutMs: 250 }), ROOT).timeoutMs, 250);
});
