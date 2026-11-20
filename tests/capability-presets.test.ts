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

/**
 * A preset's description must not promise a capability it does not grant.
 *
 * `external-integrations` used to say it connected MCP and plugins, while
 * `grantsForPreset` only ever selected names from `preset.tools` — the built-in
 * read tools. An operator choosing it would reasonably expect external access
 * and get none.
 */
test('external-integrations does not claim to grant external tools', () => {
  const preset = findCapabilityPreset('external-integrations');
  assert.ok(preset);
  assert.doesNotMatch(preset.description, /连接外部工具/);
  // Everything it grants is a built-in name, never a dynamically discovered one.
  const grants = grantsForPreset(
    'external-integrations',
    tools(['workspace_list', 'workspace_read', 'text_search', 'mcp_notes_post']),
    [],
  );
  assert.equal(grants.some((grant) => grant.name.startsWith('mcp_')), false);
});

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
