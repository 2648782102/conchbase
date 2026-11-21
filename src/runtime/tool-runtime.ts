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
  /** Read-only git tools, off unless explicitly enabled. */
  readonly enableGit?: boolean;
  /** Plugins are supplied by composition, never imported by path. */
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
  // The registry already exposes one provider per plugin; merging them is what
  // `combineToolProviders` does. A hand-written loop here duplicated its
  // dispatch and its id checks, and would have kept the old behaviour if the
  // merge point ever changed.
  const pluginProvider = pluginRegistry && pluginRegistry.tools().length > 0
    ? combineToolProviders(pluginRegistry.list().map((plugin) => plugin.provider))
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
