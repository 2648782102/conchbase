import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadPluginDirectory } from '../src/runtime/plugin-loader.js';
import { PluginRegistry } from '../src/runtime/plugin-registry.js';
import { createToolRuntime } from '../src/runtime/tool-runtime.js';

const pluginServer = fileURLToPath(new URL('./fixtures/stdio-plugin.mjs', import.meta.url));

function manifest(id: string, over: Record<string, unknown> = {}) {
  return {
    version: 1,
    id,
    name: `Plugin ${id}`,
    description: 'fixture',
    tools: [{ id: 'echo', description: 'echo a value', sideEffect: 'read' }],
    process: {
      command: process.execPath,
      args: [pluginServer],
      envAllowlist: [],
    },
    ...over,
  };
}

function writePlugin(root: string, name: string, body: unknown): void {
  const directory = path.join(root, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'plugin.json'), JSON.stringify(body));
}

/**
 * An installable plugin has to be reachable without changing code.
 *
 * `PluginRegistry`, the manifest validator, the guarded provider, and the
 * subprocess client all existed; `createToolRuntime` accepted a `plugins`
 * array that no production caller ever filled. The product claim — "the user
 * can configure a plugin" — was true only in tests.
 */
test('a plugin directory is discovered and its tools are registered', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'conchbase-plugins-'));
  try {
    writePlugin(root, 'alpha', manifest('alpha'));
    const report = loadPluginDirectory({ directory: root });
    assert.equal(report.loaded.length, 1);
    assert.deepEqual(report.skipped, []);

    const registry = new PluginRegistry(report.loaded.map((entry) => entry.definition));
    try {
      const tools = registry.tools();
      assert.equal(tools.length, 1);
      // The id is namespaced by plugin, so two plugins cannot collide on `echo`.
      assert.match(tools[0]!.id, /^alpha_/);
    } finally {
      // The registry starts a child process per plugin; leaving it running is
      // what made this file time out instead of finishing.
      registry.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a broken plugin is skipped and reported, never fatal', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'conchbase-plugins-bad-'));
  try {
    writePlugin(root, 'good', manifest('good'));
    const broken = path.join(root, 'broken');
    mkdirSync(broken);
    writeFileSync(path.join(broken, 'plugin.json'), '{ not json');
    writePlugin(root, 'wrong-shape', { version: 1, id: 'nope' });

    const report = loadPluginDirectory({ directory: root });
    assert.equal(report.loaded.length, 1, 'the valid plugin still loads');
    assert.equal(report.skipped.length, 2);
    assert.ok(report.skipped.every((line) => line.length > 0));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a missing plugin directory is a report, not a crash', () => {
  const report = loadPluginDirectory({ directory: path.join(tmpdir(), 'conchbase-plugins-absent-xyz') });
  assert.equal(report.loaded.length, 0);
  assert.equal(report.skipped.length, 1);
});

test('tools from the directory reach the Runtime tool set', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'conchbase-plugins-runtime-'));
  const workspace = path.join(root, 'workspace');
  const plugins = path.join(root, 'plugins');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(plugins, { recursive: true });
  try {
    writePlugin(plugins, 'alpha', manifest('alpha'));
    const runtime = await createToolRuntime({
      root: workspace,
      pluginsDirectory: plugins,
    });
    try {
      const ids = runtime.tools.list().map((tool) => tool.id);
      assert.ok(ids.includes('workspace_read'), 'built-ins are still present');
      assert.ok(ids.some((id) => id.startsWith('alpha_')), `plugin tool missing from ${ids.join(',')}`);
    } finally {
      await runtime.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
