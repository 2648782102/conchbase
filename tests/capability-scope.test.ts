import assert from 'node:assert/strict';
import test from 'node:test';
import { projectSkills, projectToolProvider } from '../src/runtime/capability-grants.js';
import type { ToolProvider } from '../src/runtime/tool-provider.js';

/**
 * Narrowing behaviour, pinned directly.
 *
 * These were only covered indirectly through task tests, which is thin for a
 * security boundary: the rule is "grants can only narrow", and a regression
 * would silently widen what a model can do rather than fail loudly.
 */

function provider(ids: readonly string[]): ToolProvider {
  return {
    list: () => ids.map((id) => ({
      id, version: 1 as const, description: id, sideEffect: 'read' as const,
    })),
    has: (toolId: string) => ids.includes(toolId),
    invoke: () => { throw new Error('not used'); },
  };
}

test('no grants means no tools at all', () => {
  assert.equal(projectToolProvider(provider(['a', 'b']), []), undefined);
});

test('a grant for an unregistered tool grants nothing', () => {
  assert.equal(projectToolProvider(provider(['a']), [{ kind: 'tool', name: 'zzz' }]), undefined);
});

test('only the named tools survive, in registration order', () => {
  const projected = projectToolProvider(provider(['a', 'b', 'c']), [
    { kind: 'tool', name: 'c' },
    { kind: 'tool', name: 'a' },
  ]);
  assert.deepEqual(projected?.list().map((tool) => tool.id), ['a', 'c']);
});

test('a projected provider refuses a tool it does not expose', () => {
  const projected = projectToolProvider(provider(['a', 'b']), [{ kind: 'tool', name: 'a' }]);
  assert.equal(projected?.has('b'), false);
  assert.throws(() => projected?.invoke('b', {}), /not granted/);
});

test('a skill grant never authorizes a tool', () => {
  // Same name, different namespace: the rule must not leak across kinds.
  assert.equal(projectToolProvider(provider(['review']), [{ kind: 'skill', name: 'review' }]), undefined);
});

test('skills narrow by skill grants only, and ignore tool grants', () => {
  const skills = [{ name: 'review', instructions: 'x' }, { name: 'plan', instructions: 'y' }];
  assert.deepEqual(
    projectSkills(skills, [{ kind: 'skill', name: 'review' }]).map((skill) => skill.name),
    ['review'],
  );
  assert.deepEqual(projectSkills(skills, [{ kind: 'tool', name: 'review' }]), []);
  assert.deepEqual(projectSkills(skills, []), []);
});
