import type {
  ToolArguments,
  ToolDefinition,
  ToolExecutionResult,
  ToolProvider,
} from './tool-provider.js';
import {
  PLUGIN_ID_PATTERN,
  TOOL_ID_PATTERN,
  parsePluginManifest,
  type PluginManifest,
} from './plugin-manifest.js';
import { SubprocessPluginClient } from './subprocess-plugin.js';

/**
 * Plugin composition.
 *
 * A plugin supplies a manifest and an implementation provider. The registry —
 * not the plugin — decides the visible tool ids and enforces that a declared
 * tool is the only surface reachable. Implementations never receive the store
 * or secret handles.
 */

export interface PluginDefinition {
  readonly manifest: unknown;
  readonly implementation: ToolProvider;
}

export interface LoadedPlugin {
  readonly manifest: PluginManifest;
  readonly provider: ToolProvider;
}

export interface PluginInvocationGuard {
  /** Whether an Agent may use this tool, given its pinned grants. */
  isGranted(toolId: string): boolean;
  /** Whether a consequential operation must pause for approval. */
  requiresApproval(toolId: string): boolean;
}

export class PluginRegistry {
  private readonly plugins = new Map<string, LoadedPlugin>();

  constructor(definitions: readonly PluginDefinition[] = []) {
    for (const definition of definitions) this.register(definition);
  }

  register(definition: PluginDefinition): LoadedPlugin {
    const manifest = parsePluginManifest(definition.manifest);
    if (this.plugins.has(manifest.id)) {
      throw new Error(`Duplicate plugin id: ${manifest.id}.`);
    }
    for (const declared of manifest.tools) {
      const implementation = definition.implementation;
      if (!implementation.has(declared.id)) {
        throw new Error(`Plugin ${manifest.id} declares missing tool ${declared.id}.`);
      }
      if (!implementation.list().some((tool) => tool.id === declared.id)) {
        throw new Error(`Plugin ${manifest.id} tool ${declared.id} is not discoverable.`);
      }
    }
    let implementation = definition.implementation;
    if (manifest.process) {
      const client = new SubprocessPluginClient({
        command: manifest.process.command,
        args: manifest.process.args,
        envAllowlist: manifest.process.envAllowlist,
        ...(manifest.process.startTimeoutMs !== undefined ? { startTimeoutMs: manifest.process.startTimeoutMs } : {}),
        ...(manifest.process.callTimeoutMs !== undefined ? { callTimeoutMs: manifest.process.callTimeoutMs } : {}),
        ...(manifest.process.maxResultBytes !== undefined ? { maxResultBytes: manifest.process.maxResultBytes } : {}),
      });
      // A failed spawn or start timeout must not surface as an unhandled
      // rejection, which would take the process down. The plugin stays loaded
      // and every call fails with 'Plugin is not running.', as before.
      void client.start().catch(() => undefined);
      implementation = Object.freeze({
        list: () => definition.implementation.list(),
        has: (id: string) => definition.implementation.has(id),
        invoke: async (id: string, args: Parameters<ToolProvider['invoke']>[1]) => client.invoke(id, args),
      });
    }
    const provider = createGuardedProvider(manifest, implementation);
    const loaded = Object.freeze({ manifest, provider });
    this.plugins.set(manifest.id, loaded);
    return loaded;
  }

  list(): readonly LoadedPlugin[] {
    return Object.freeze([...this.plugins.values()]);
  }

  get(pluginId: string): LoadedPlugin | undefined {
    if (!PLUGIN_ID_PATTERN.test(pluginId)) return undefined;
    return this.plugins.get(pluginId);
  }

  /** All declared tools, with Runtime-owned ids. */
  tools(): readonly ToolDefinition[] {
    return Object.freeze(this.list().flatMap((plugin) =>
      plugin.manifest.tools.map((tool) => Object.freeze({
        id: tool.id,
        version: 1 as const,
        description: tool.description,
        sideEffect: tool.sideEffect,
        ...(tool.parameters ? { parameters: tool.parameters } : {}),
      }))));
  }
}

/**
 * Restricts a plugin implementation to its declared tools.
 *
 * This wrapper is what makes a plugin safe to compose into the Runtime tool
 * surface: unknown ids cannot reach the implementation, declarations cannot be
 * widened at runtime, and consequential calls pass the same approval gate as
 * every other tool.
 */
export function createGuardedProvider(
  manifest: PluginManifest,
  implementation: ToolProvider,
  guard?: PluginInvocationGuard,
): ToolProvider {
  const declared = new Map(manifest.tools.map((tool) => [tool.id, tool]));
  const definitions: readonly ToolDefinition[] = Object.freeze(manifest.tools.map((tool) => Object.freeze({
    id: tool.id,
    version: 1 as const,
    description: tool.description,
    sideEffect: tool.sideEffect,
    ...(tool.parameters ? { parameters: tool.parameters } : {}),
  })));
  return Object.freeze({
    list: () => definitions,
    has: (toolId: string) => declared.has(toolId),
    invoke: async (toolId: string, args: ToolArguments): Promise<ToolExecutionResult> => {
      if (!TOOL_ID_PATTERN.test(toolId) || !declared.has(toolId)) {
        throw new Error(`Plugin ${manifest.id} does not declare tool ${toolId}.`);
      }
      if (guard && !guard.isGranted(toolId)) {
        throw new Error(`Plugin tool ${toolId} is not granted to this Agent revision.`);
      }
      if (guard?.requiresApproval(toolId)) {
        throw new Error(`Plugin tool ${toolId} requires approval before execution.`);
      }
      return implementation.invoke(toolId, args);
    },
  });
}
