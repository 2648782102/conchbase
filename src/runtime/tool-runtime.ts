import { combineToolProviders, createBuiltinReadTools, type ToolProvider } from './tool-provider.js';
import { createMcpToolProvider } from './mcp-provider.js';

export interface ToolRuntime {
  readonly tools: ToolProvider;
  close(): Promise<void>;
}

export async function createToolRuntime(options: {
  readonly root: string;
  readonly mcpConfigPath?: string;
}): Promise<ToolRuntime> {
  const builtins = createBuiltinReadTools({ root: options.root });
  if (!options.mcpConfigPath) {
    return Object.freeze({ tools: builtins, close: async () => undefined });
  }
  const mcp = await createMcpToolProvider(options.mcpConfigPath);
  return Object.freeze({
    tools: combineToolProviders([builtins, mcp]),
    close: () => mcp.close(),
  });
}
