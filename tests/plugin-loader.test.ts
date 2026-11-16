import assert from 'node:assert/strict';
import test from 'node:test';
import { PluginManifestError, parsePluginManifest } from '../src/runtime/plugin-manifest.js';
import { PluginRegistry, createGuardedProvider } from '../src/runtime/plugin-registry.js';
import type { ToolProvider } from '../src/runtime/tool-provider.js';

/** Plugin loader contract: declarations are data, authority stays with the Runtime. */

const manifest = {
  version: 1,
  id: 'demo_plugin',
  name: 'Demo Plugin',
  description: 'A bounded test plugin.',
  tools: [
    { id: 'demo_read', description: 'Read something.', sideEffect: 'read' },
    { id: 'demo_write', description: 'Write something.', sideEffect: 'write' },
  ],
};

function implementation(extraTools: readonly string[] = []): ToolProvider {
  const tools = ['demo_read', 'demo_write', 'secret_tool', ...extraTools];
  return {
    list: () => tools.map((id) => ({ id, version: 1 as const, description: id, sideEffect: 'read' as const })),
    has: (id: string) => tools.includes(id),
    invoke: (id: string) => ({ ok: true, summary: `called ${id}`, digest: `sha256:${id}`, bytes: 1 }),
  };
}

test('a manifest only declares ids and side effects', () => {
  const parsed = parsePluginManifest(manifest);
  assert.equal(parsed.id, 'demo_plugin');
  assert.deepEqual(parsed.tools.map((tool) => tool.id), ['demo_read', 'demo_write']);
  assert.equal(parsed.tools[1]?.sideEffect, 'write');
});

test('an invalid manifest is rejected at load time', () => {
  assert.throws(() => parsePluginManifest({ ...manifest, version: 99 }), PluginManifestError);
  assert.throws(() => parsePluginManifest({
    ...manifest,
    tools: [{ id: 'bad_tool', description: 'x', sideEffect: 'admin' }],
  }), PluginManifestError);
  assert.throws(() => parsePluginManifest({
    ...manifest,
    tools: [
      { id: 'dup_tool', description: 'x', sideEffect: 'read' },
      { id: 'dup_tool', description: 'y', sideEffect: 'read' },
    ],
  }), /duplicate ids/);
  assert.throws(() => parsePluginManifest({ ...manifest, unexpected: true }), /unknown fields/);
});

test('the registry exposes only declared tools with runtime-owned ids', () => {
  const registry = new PluginRegistry([{ manifest, implementation: implementation() }]);
  const tools = registry.tools();
  assert.deepEqual(tools.map((tool) => tool.id), ['demo_read', 'demo_write']);
  for (const tool of tools) assert.equal(tool.version, 1);
  assert.equal(registry.get('demo_plugin')?.manifest.name, 'Demo Plugin');
});

test('a plugin cannot call an undeclared implementation tool', async () => {
  const registry = new PluginRegistry([{ manifest, implementation: implementation() }]);
  const provider = registry.get('demo_plugin')!.provider;
  await assert.rejects(async () => provider.invoke('secret_tool', {}), /does not declare/);
  assert.equal(provider.has('secret_tool'), false);
});

test('grants are enforced before plugin code runs', async () => {
  const calls: string[] = [];
  const impl: ToolProvider = {
    list: () => implementation().list(),
    has: (id) => implementation().has(id),
    invoke: (id) => {
      calls.push(id);
      return { ok: true, summary: id, digest: `sha256:${id}`, bytes: 1 };
    },
  };
  const guarded = createGuardedProvider(parsePluginManifest(manifest), impl, {
    isGranted: (id) => id === 'demo_read',
    requiresApproval: () => false,
  });
  assert.equal((await guarded.invoke('demo_read', {})).ok, true);
  await assert.rejects(async () => guarded.invoke('demo_write', {}), /not granted/);
  assert.deepEqual(calls, ['demo_read'], 'the denied implementation never runs');
});

test('consequential plugin tools cannot bypass the approval gate', async () => {
  const calls: string[] = [];
  const impl: ToolProvider = {
    list: () => implementation().list(),
    has: (id) => implementation().has(id),
    invoke: (id) => {
      calls.push(id);
      return { ok: true, summary: id, digest: `sha256:${id}`, bytes: 1 };
    },
  };
  const guarded = createGuardedProvider(parsePluginManifest(manifest), impl, {
    isGranted: () => true,
    requiresApproval: (id) => id === 'demo_write',
  });
  await assert.rejects(async () => guarded.invoke('demo_write', {}), /requires approval/);
  assert.deepEqual(calls, [], 'a write never reaches plugin code without approval');
});

test('a missing implementation tool fails at registration', () => {
  const partial: ToolProvider = {
    list: () => [{ id: 'demo_read', version: 1, description: 'r', sideEffect: 'read' }],
    has: (id) => id === 'demo_read',
    invoke: () => ({ ok: true, summary: 'ok', digest: 'sha256:x', bytes: 1 }),
  };
  assert.throws(
    () => new PluginRegistry([{ manifest, implementation: partial }]),
    /missing tool demo_write/,
  );
});

test('duplicate plugin ids fail closed', () => {
  const registry = new PluginRegistry([{ manifest, implementation: implementation() }]);
  assert.throws(
    () => registry.register({ manifest, implementation: implementation() }),
    /Duplicate plugin id/,
  );
});

test('a subprocess manifest accepts only bounded process declarations', () => {
  const withProcess = parsePluginManifest({
    ...manifest,
    process: {
      command: '/usr/bin/node',
      args: ['plugin.mjs', '--safe'],
      envAllowlist: ['CONCHBASE_MAGPIE_APP_KEY'],
      callTimeoutMs: 2_000,
    },
  });
  assert.equal(withProcess.process?.command, '/usr/bin/node');
  assert.deepEqual([...withProcess.process?.envAllowlist ?? []], ['CONCHBASE_MAGPIE_APP_KEY']);

  assert.throws(() => parsePluginManifest({
    ...manifest,
    process: { command: '/bin/sh', args: [], envAllowlist: ['process.env'] },
  }), /envAllowlist/);
  // Args are static operator configuration, not model input. The manifest
  // constrains their count and length; it does not pretend to sanitize content.
  assert.equal(parsePluginManifest({
    ...manifest,
    process: { command: '/usr/bin/node', args: ['plugin.mjs', '--safe'], envAllowlist: [] },
  }).process?.args.length, 2);
});
