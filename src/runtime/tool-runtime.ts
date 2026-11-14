import { combineToolProviders, createBuiltinReadTools, type ToolProvider } from './tool-provider.js';
import { createMcpToolProvider } from './mcp-provider.js';
import { loadSkillDirectory, type SkillSet } from './skill-provider.js';

export interface ToolRuntime {
  readonly tools: ToolProvider;
  readonly skills: SkillSet;
  close(): Promise<void>;
}

export async function createToolRuntime(options: {
  readonly root: string;
  readonly mcpConfigPath?: string;
  readonly skillsDirectory?: string;
}): Promise<ToolRuntime> {
  const builtins = createBuiltinReadTools({ root: options.root });
  const skills = options.skillsDirectory
    ? loadSkillDirectory({ directory: options.skillsDirectory })
    : Object.freeze({ skills: Object.freeze([]), instructions: '' });
  if (!options.mcpConfigPath) {
    return Object.freeze({ tools: builtins, skills, close: async () => undefined });
  }
  const mcp = await createMcpToolProvider(options.mcpConfigPath);
  return Object.freeze({
    tools: combineToolProviders([builtins, mcp]),
    skills,
    close: () => mcp.close(),
  });
}
