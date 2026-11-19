import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CAPABILITY_PRESETS,
  findCapabilityPreset,
  grantsForPreset,
} from '../src/runtime/capability-grants.js';
import type { ToolProvider } from '../src/runtime/tool-provider.js';

function tools(ids: readonly string[]): ToolProvider {
  return {
    list: () => ids.map((id) => ({ id, version: 1, description: id, sideEffect: 'read' as const })),
    has: (id) => ids.includes(id),
    invoke: () => { throw new Error('not called'); },
  };
}

test('presets are named, described, and unique', () => {
  assert.equal(CAPABILITY_PRESETS.length >= 4, true);
  const ids = CAPABILITY_PRESETS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const preset of CAPABILITY_PRESETS) {
    assert.ok(preset.label.length > 0);
    assert.ok(preset.description.length > 0);
  }
});

test('read-only grants no write tool even if it is registered', () => {
  const grants = grantsForPreset('read-only', tools(['workspace_list', 'workspace_read', 'text_search', 'workspace_write']), []);
  assert.equal(grants.some((g) => g.name === 'workspace_write'), false);
  assert.equal(grants.some((g) => g.name === 'workspace_read'), true);
});

test('workspace-editing includes the write tool when registered', () => {
  const grants = grantsForPreset('workspace-editing', tools(['workspace_list', 'workspace_read', 'workspace_write']), []);
  assert.equal(grants.some((g) => g.name === 'workspace_write'), true);
  assert.equal(findCapabilityPreset('workspace-editing')?.allowsWrites, true);
});

test('local-commands only grants tools that exist', () => {
  const grants = grantsForPreset('local-commands', tools(['workspace_read']), []);
  assert.deepEqual(grants.map((g) => g.name), ['workspace_read']);
});

test('external-integrations never auto-grants skills', () => {
  const grants = grantsForPreset('external-integrations', tools(['workspace_read']), [{ name: 'some-skill' } as never]);
  assert.equal(grants.some((g) => g.kind === 'skill'), false);
});

test('an unknown preset yields no grants', () => {
  assert.deepEqual(grantsForPreset('nope' as never, tools(['workspace_read']), []), []);
});
