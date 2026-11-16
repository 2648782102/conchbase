import { combineToolProviders, createBuiltinReadTools, ToolRejectedError, type ToolProvider } from './tool-provider.js';
import { createMcpToolProvider } from './mcp-provider.js';
import { loadSkillDirectory, type SkillSet } from './skill-provider.js';
import { createBuiltinWriteTools } from './write-tools.js';
import { createGitReadTools } from './git-tools.js';
import { PluginRegistry, type PluginDefinition } from './plugin-registry.js';

export interface ToolRuntime {
  readonly tools: ToolProvider;
  readonly skills: SkillSet;
  close(): Promise<void>;
}

export async function createToolRuntime(options: {
  readonly root: string;
  readonly mcpConfigPath?: string;
  readonly skillsDirectory?: string;
  readonly allowWrites?: boolean;
  /** ADR 0095: read-only git tools, off unless explicitly enabled. */
  readonly enableGit?: boolean;
  /** ADR 0096: plugins are supplied by composition, never imported by path. */
  readonly plugins?: readonly PluginDefinition[];
}): Promise<ToolRuntime> {
  const builtins = createBuiltinReadTools({ root: options.root });
  const writes = options.allowWrites ? createBuiltinWriteTools({ root: options.root }) : null;
  // Git is a read-only provider layered on the filesystem tools. It is opt-in
  // because it executes a subprocess, unlike every other built-in tool.
  const git = options.enableGit ? createGitReadTools({ root: options.root }) : null;
  const pluginRegistry = options.plugins && options.plugins.length > 0
    ? new PluginRegistry(options.plugins)
    : null;
  const pluginProvider = pluginRegistry && pluginRegistry.tools().length > 0
    ? {
      list: () => pluginRegistry.tools(),
      has: (id: string) => pluginRegistry.tools().some((tool) => tool.id === id),
      invoke: async (id: string, args: Parameters<ToolProvider['invoke']>[1]) => {
        for (const plugin of pluginRegistry.list()) {
          if (plugin.provider.has(id)) return plugin.provider.invoke(id, args);
        }
        throw new ToolRejectedError('unknown_tool');
      },
    }
    : null;
  const providers = [
    builtins,
    ...(writes ? [writes] : []),
    ...(git ? [git] : []),
    ...(pluginProvider ? [pluginProvider] : []),
  ];
  const baseTools = providers.length === 1 ? builtins : combineToolProviders(providers);
  const skills = options.skillsDirectory
    ? loadSkillDirectory({ directory: options.skillsDirectory })
    : Object.freeze({ skills: Object.freeze([]), instructions: '' });
  if (!options.mcpConfigPath) {
    return Object.freeze({ tools: baseTools, skills, close: async () => undefined });
  }
  const mcp = await createMcpToolProvider(options.mcpConfigPath);
  return Object.freeze({
    tools: combineToolProviders([baseTools, mcp]),
    skills,
    close: () => mcp.close(),
  });
}
