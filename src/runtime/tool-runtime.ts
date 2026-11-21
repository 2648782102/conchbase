import { combineToolProviders, createBuiltinReadTools, ToolRejectedError, type ToolProvider } from './tool-provider.js';
import { createMcpToolProvider } from './mcp-provider.js';
import { loadSkillDirectory, type SkillSet } from './skill-provider.js';
import { createBuiltinWriteTools } from './write-tools.js';
import { createGitReadTools } from './git-tools.js';
import { PluginRegistry, type PluginDefinition } from './plugin-registry.js';
import { loadPluginDirectory } from './plugin-loader.js';
import { createBuiltinHttpTools } from './http-tools.js';

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
  /**
   * A directory of installed plugins.
   *
   * Present so an operator can add a plugin without changing code. A broken
   * plugin is skipped with a report entry rather than preventing startup.
   */
  readonly pluginsDirectory?: string;
  /**
   * Outbound HTTP, off unless explicitly enabled.
   *
   * A network tool is the one capability whose failure mode is outside this
   * machine, so it is opt-in like git rather than part of the default surface.
   */
  readonly enableHttp?: boolean;
  /**
   * Whether outbound HTTP may reach private, loopback, and link-local addresses.
   *
   * Operator-only, and separate from `enableHttp`: turning on the tool does not
   * turn off the SSRF boundary.
   */
  readonly allowPrivateNetworks?: boolean;
}): Promise<ToolRuntime> {
  const builtins = createBuiltinReadTools({ root: options.root });
  const writes = options.allowWrites ? createBuiltinWriteTools({ root: options.root }) : null;
  // Git is a read-only provider layered on the filesystem tools. It is opt-in
  // because it executes a subprocess, unlike every other built-in tool.
  const git = options.enableGit ? createGitReadTools({ root: options.root }) : null;
  const http = options.enableHttp
    ? createBuiltinHttpTools({ allowPrivateNetworks: options.allowPrivateNetworks === true })
    : null;
  const loaded = options.pluginsDirectory ? loadPluginDirectory({ directory: options.pluginsDirectory }) : null;
  const definitions = [
    ...(options.plugins ?? []),
    ...(loaded?.loaded.map((entry) => entry.definition) ?? []),
  ];
  const pluginRegistry = definitions.length > 0 ? new PluginRegistry(definitions) : null;
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
    ...(http ? [http] : []),
    ...(pluginProvider ? [pluginProvider] : []),
  ];
  const baseTools = providers.length === 1 ? builtins : combineToolProviders(providers);
  const skills = options.skillsDirectory
    ? loadSkillDirectory({ directory: options.skillsDirectory })
    : Object.freeze({ skills: Object.freeze([]), instructions: '' });
  /*
   * One close path for both seams.
   *
   * A plugin subprocess and an MCP server are both child processes; closing only
   * the one that happened to be configured last left the other running after the
   * Runtime exited.
   */
  const closeAll = async () => {
    pluginRegistry?.close();
  };
  if (!options.mcpConfigPath) {
    return Object.freeze({ tools: baseTools, skills, close: closeAll });
  }
  const mcp = await createMcpToolProvider(options.mcpConfigPath);
  return Object.freeze({
    tools: combineToolProviders([baseTools, mcp]),
    skills,
    close: async () => {
      await mcp.close();
      await closeAll();
    },
  });
}
