/**
 * Loads plugins from an operator-configured directory.
 *
 * The manifest validator, the registry, the guarded provider, and the
 * subprocess client all existed, and nothing constructed them from a plugin an
 * operator could actually install. `createToolRuntime` accepted a `plugins`
 * array that no production caller ever passed, so "the user can configure a
 * plugin" was true only in tests.
 *
 * The layout is deliberately boring: one directory per plugin, each with
 * `plugin.json`. A manifest is data — it names tools and their side-effect
 * class — and a plugin that declares a `process` block is run through the
 * bounded stdio client. Nothing here can grant itself a capability: the Runtime
 * still decides, per Agent revision, whether a tool may run at all.
 *
 * A broken plugin is skipped and reported, never fatal. One half-written
 * `plugin.json` must not stop a Runtime from starting.
 */
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  type PluginDefinition,
} from './plugin-registry.js';
import {
  MAX_DESCRIPTION,
  PLUGIN_ID_PATTERN,
  parsePluginManifest,
  type PluginManifest,
} from './plugin-manifest.js';
import type { ToolExecutionResult, ToolProvider } from './tool-provider.js';

export const MAX_PLUGINS = 32;
export const MANIFEST_FILENAME = 'plugin.json';

export interface LoadedPluginDirectory {
  readonly definition: PluginDefinition;
}

export interface PluginLoadReport {
  readonly loaded: readonly LoadedPluginDirectory[];
  /** One line per rejected directory, safe to log: id, reason, no paths. */
  readonly skipped: readonly string[];
}

/**
 * Reads every `plugin.json` under `directory`.
 *
 * Returns definitions rather than providers so the caller keeps ownership of
 * when a subprocess starts: a Runtime that fails to bind its port must not have
 * spawned half the installed plugins first.
 */
export function loadPluginDirectory(options: {
  readonly directory: string;
}): PluginLoadReport {
  const loaded: LoadedPluginDirectory[] = [];
  const skipped: string[] = [];

  let entries: string[];
  try {
    entries = readdirSync(options.directory).sort();
  } catch {
    // A configured-but-missing directory is an operator mistake, not a crash.
    return Object.freeze({ loaded: Object.freeze([]), skipped: Object.freeze([`plugins: cannot read ${path.basename(options.directory)}`]) });
  }

  for (const name of entries.slice(0, MAX_PLUGINS)) {
    const root = path.join(options.directory, name);
    try {
      if (!statSync(root).isDirectory()) continue;
      // A symlinked plugin directory could point outside the configured tree;
      // resolving first keeps "inside the directory" a real property.
      const realRoot = realpathSync(root);
      if (!realRoot.startsWith(`${realpathSync(options.directory)}${path.sep}`)) {
        skipped.push(`${name}: resolves outside the plugins directory`);
        continue;
      }
      const manifestPath = path.join(realRoot, MANIFEST_FILENAME);
      const manifest = parsePluginManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
      if (!PLUGIN_ID_PATTERN.test(manifest.id)) {
        skipped.push(`${name}: invalid plugin id`);
        continue;
      }
      loaded.push(buildPlugin(manifest));
    } catch (cause) {
      skipped.push(`${name}: ${reason(cause)}`);
    }
  }

  return Object.freeze({
    loaded: Object.freeze(loaded),
    skipped: Object.freeze(skipped),
  });
}

function buildPlugin(
  manifest: PluginManifest,
): LoadedPluginDirectory {
  if (!manifest.process) {
    throw new Error('an in-process plugin has no implementation to load');
  }
  /*
   * Tools are namespaced by plugin id.
   *
   * Without this, two independently installed plugins that both declare `echo`
   * produce duplicate tool ids, and `combineToolProviders` refuses the whole
   * surface — so installing a second plugin would break every built-in tool.
   * The manifest's own ids stay the plugin's internal vocabulary; the Runtime
   * sees `<pluginId>_<toolId>`.
   */
  const toolName = (id: string) => `${manifest.id}_${id}`;
  /*
   * `PluginRegistry` owns the subprocess lifecycle.
   *
   * It parses the manifest again, validates every declared tool against the
   * implementation, wraps the result in the guarded provider, and starts the
   * child lazily. Re-implementing any of that here is how a second rule appears;
   * this provider only has to be honest about what it declares.
   */
  const provider: ToolProvider = {
    list: () => manifest.tools.map((tool) => ({
      id: toolName(tool.id),
      version: 1 as const,
      description: tool.description.slice(0, MAX_DESCRIPTION),
      sideEffect: tool.sideEffect,
      ...(tool.parameters ? { parameters: tool.parameters } : {}),
    })),
    has: (toolId) => manifest.tools.some((tool) => toolName(tool.id) === toolId),
    // The registry replaces this with a client-backed invoke; reaching it means
    // the plugin was composed without going through the registry.
    invoke: async (toolId: string): Promise<ToolExecutionResult> => {
      throw new Error(`plugin ${manifest.id} tool ${toolId} has no running implementation`);
    },
  };
  /*
   * The registry validates that every declared tool is discoverable and that
   * the implementation has it, so the manifest it receives must declare the
   * same names this provider exposes.
   */
  const namespaced: PluginManifest = Object.freeze({
    ...manifest,
    tools: Object.freeze(manifest.tools.map((tool) => Object.freeze({ ...tool, id: toolName(tool.id) }))),
  });
  return Object.freeze({ definition: Object.freeze({ manifest: namespaced, implementation: provider }) });
}

function reason(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : 'invalid plugin';
  return message.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 160);
}
