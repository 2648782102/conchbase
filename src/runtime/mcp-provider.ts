import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  ToolRejectedError,
  type ToolArguments,
  type ToolDefinition,
  type ToolExecutionResult,
  type ToolProvider,
  type ToolSideEffect,
} from './tool-provider.js';

const MAX_RESULT_BYTES = 8_192;
const START_TIMEOUT_MS = 5_000;
const CALL_TIMEOUT_MS = 5_000;
const SERVER_ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_.-]{1,64}$/;

export interface McpToolDeclaration {
  readonly name: string;
  readonly sideEffect: ToolSideEffect;
  /** Optional human-facing description override; discovery supplies one otherwise. */
  readonly description?: string;
  /** Optional parameter schema override; discovery supplies one otherwise. */
  readonly inputSchema?: Readonly<Record<string, unknown>>;
}

interface McpDiscoveredTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Readonly<Record<string, unknown>>;
}

export interface McpServerDeclaration {
  readonly id: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly tools?: readonly McpToolDeclaration[];
  /**
   * Side-effect class applied to tools discovered from `tools/list` when the
   * server did not declare them individually. MCP does not report a trustworthy
   * side-effect class, so undeclared tools default to `read`.
   */
  readonly discoverySideEffect?: ToolSideEffect;
  readonly startTimeoutMs?: number;
  readonly callTimeoutMs?: number;
  readonly maxResultBytes?: number;
}

export interface McpConfig {
  readonly servers: readonly McpServerDeclaration[];
}

export interface McpToolProvider extends ToolProvider {
  close(): Promise<void>;
}

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new ToolRejectedError('invalid_mcp_config', `${label} has unknown fields: ${unknown.join(', ')}`);
}

function parseDeclaration(value: unknown, index: number): McpServerDeclaration {
  if (!isRecord(value)) throw new ToolRejectedError('invalid_mcp_config', `servers[${index}] must be an object.`);
  assertExactKeys(
    value,
    [
      'id',
      'command',
      'args',
      'env',
      'tools',
      'discoverySideEffect',
      'startTimeoutMs',
      'callTimeoutMs',
      'maxResultBytes',
    ],
    `servers[${index}]`,
  );
  const id = value.id;
  if (typeof id !== 'string' || !SERVER_ID_PATTERN.test(id)) {
    throw new ToolRejectedError('invalid_mcp_config', `servers[${index}].id must be a bounded lowercase identifier.`);
  }
  const command = value.command;
  if (typeof command !== 'string' || command.trim().length === 0 || !path.isAbsolute(command)) {
    throw new ToolRejectedError('invalid_mcp_config', `servers[${index}].command must be an absolute path.`);
  }
  if (!Array.isArray(value.args) || value.args.length > 32 || value.args.some((arg) => typeof arg !== 'string' || arg.length > 512)) {
    throw new ToolRejectedError('invalid_mcp_config', `servers[${index}].args must be at most 32 bounded strings.`);
  }
  let env: Record<string, string> | undefined;
  if (value.env !== undefined) {
    if (!isRecord(value.env) || Object.keys(value.env).length > 16) {
      throw new ToolRejectedError('invalid_mcp_config', `servers[${index}].env must be at most 16 entries.`);
    }
    env = {};
    for (const [key, entry] of Object.entries(value.env)) {
      if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(key) || typeof entry !== 'string' || entry.length > 512) {
        throw new ToolRejectedError('invalid_mcp_config', `servers[${index}].env entry is not bounded.`);
      }
      env[key] = entry;
    }
  }
  let tools: McpToolDeclaration[] | undefined;
  if (value.tools !== undefined) {
    if (!Array.isArray(value.tools) || value.tools.length > 64) {
      throw new ToolRejectedError('invalid_mcp_config', `servers[${index}].tools must be at most 64 entries.`);
    }
    tools = value.tools.map((entry, toolIndex) => {
      if (!isRecord(entry)) throw new ToolRejectedError('invalid_mcp_config', `servers[${index}].tools[${toolIndex}] must be an object.`);
      assertExactKeys(
        entry,
        ['name', 'sideEffect', 'description', 'inputSchema'],
        `servers[${index}].tools[${toolIndex}]`,
      );
      if (typeof entry.name !== 'string' || !TOOL_NAME_PATTERN.test(entry.name)) {
        throw new ToolRejectedError('invalid_mcp_config', `servers[${index}].tools[${toolIndex}].name is invalid.`);
      }
      if (entry.sideEffect !== 'read' && entry.sideEffect !== 'write' && entry.sideEffect !== 'external') {
        throw new ToolRejectedError('invalid_mcp_config', `servers[${index}].tools[${toolIndex}].sideEffect is invalid.`);
      }
      if (entry.description !== undefined
        && (typeof entry.description !== 'string' || entry.description.length > 512)) {
        throw new ToolRejectedError('invalid_mcp_config', `servers[${index}].tools[${toolIndex}].description is invalid.`);
      }
      if (entry.inputSchema !== undefined && !isRecord(entry.inputSchema)) {
        throw new ToolRejectedError('invalid_mcp_config', `servers[${index}].tools[${toolIndex}].inputSchema is invalid.`);
      }
      return Object.freeze({
        name: entry.name,
        sideEffect: entry.sideEffect,
        ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
        ...(isRecord(entry.inputSchema) ? { inputSchema: entry.inputSchema } : {}),
      });
    });
  }
  const boundedTimeout = (input: unknown, fallback: number): number =>
    typeof input === 'number' && Number.isInteger(input) && input >= 100 && input <= 60_000 ? input : fallback;
  const boundedBytes = (input: unknown, fallback: number): number =>
    typeof input === 'number' && Number.isInteger(input) && input >= 1 && input <= MAX_RESULT_BYTES ? input : fallback;
  const discoverySideEffect = value.discoverySideEffect;
  if (
    discoverySideEffect !== undefined
    && discoverySideEffect !== 'read'
    && discoverySideEffect !== 'write'
    && discoverySideEffect !== 'external'
  ) {
    throw new ToolRejectedError(
      'invalid_mcp_config',
      `servers[${index}].discoverySideEffect is invalid.`,
    );
  }
  return Object.freeze({
    id,
    command,
    args: Object.freeze([...value.args as string[]]),
    ...(env ? { env: Object.freeze(env) } : {}),
    ...(tools ? { tools: Object.freeze(tools) } : {}),
    ...(discoverySideEffect ? { discoverySideEffect } : {}),
    startTimeoutMs: boundedTimeout(value.startTimeoutMs, START_TIMEOUT_MS),
    callTimeoutMs: boundedTimeout(value.callTimeoutMs, CALL_TIMEOUT_MS),
    maxResultBytes: boundedBytes(value.maxResultBytes, MAX_RESULT_BYTES),
  });
}

export function loadMcpConfig(input: unknown): McpConfig {
  let value: unknown = input;
  if (typeof input === 'string') {
    let raw: string;
    try {
      raw = readFileSync(input, 'utf8');
    } catch {
      throw new ToolRejectedError('invalid_mcp_config', 'MCP config file is not readable.');
    }
    try {
      value = JSON.parse(raw);
    } catch {
      throw new ToolRejectedError('invalid_mcp_config', 'MCP config file is not valid JSON.');
    }
  }
  if (!isRecord(value)) throw new ToolRejectedError('invalid_mcp_config', 'MCP config must be an object.');
  assertExactKeys(value, ['servers'], 'config');
  if (!Array.isArray(value.servers) || value.servers.length > 16) {
    throw new ToolRejectedError('invalid_mcp_config', 'config.servers must be at most 16 entries.');
  }
  const servers = value.servers.map(parseDeclaration);
  const ids = new Set(servers.map((server) => server.id));
  if (ids.size !== servers.length) throw new ToolRejectedError('invalid_mcp_config', 'server ids must be unique.');
  return Object.freeze({ servers: Object.freeze(servers) });
}

class McpConnection {
  private readonly client: Client;
  private readonly transport: StdioClientTransport;
  private closed = false;

  constructor(declaration: McpServerDeclaration) {
    this.transport = new StdioClientTransport({
      command: declaration.command,
      args: [...declaration.args],
      stderr: 'pipe',
      env: {
        PATH: '',
        NODE_OPTIONS: '',
        ...declaration.env,
      },
    });
    this.client = new Client(
      { name: 'conchbase', version: '1.0.0' },
      { capabilities: {} },
    );
  }

  async initialize(_timeoutMs: number): Promise<void> {
    await this.client.connect(this.transport);
  }

  async listTools(_timeoutMs: number): Promise<readonly McpDiscoveredTool[]> {
    const result = await this.client.listTools();
    if (!isRecord(result) || !Array.isArray(result.tools)) {
      throw new ToolRejectedError('mcp_invalid_response');
    }
    return result.tools.flatMap((entry) => {
      if (!isRecord(entry) || typeof entry.name !== 'string') return [];
      return [{
        name: entry.name,
        ...(typeof entry.description === 'string' && entry.description.length > 0
          ? { description: entry.description }
          : {}),
        ...(isRecord(entry.inputSchema) ? { inputSchema: entry.inputSchema } : {}),
      }];
    });
  }

  async callTool(name: string, args: ToolArguments, timeoutMs: number): Promise<unknown> {
    try {
      return await withTimeout(
        this.client.callTool({ name, arguments: { ...args } }, undefined, {
          timeout: timeoutMs,
        }),
        timeoutMs,
        'mcp_timeout',
      );
    } catch (cause) {
      if (cause instanceof ToolRejectedError) throw cause;
      throw new ToolRejectedError('mcp_call_failed');
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.client.close();
    } catch {
      await this.transport.close().catch(() => undefined);
    }
  }
}

/**
 * The SDK applies its own request timeout; this guard makes the bound explicit
 * and keeps the observable error code stable for the Agent loop.
 */
function withTimeout<T>(operation: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new ToolRejectedError(code));
    }, timeoutMs);
    timer.unref?.();
    operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (cause: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(cause);
      },
    );
  });
}

function summarize(result: unknown, maxBytes: number): { summary: string; bytes: number } {
  if (!isRecord(result) || !Array.isArray(result.content)) {
    throw new ToolRejectedError('mcp_invalid_response');
  }
  const parts: string[] = [];
  for (const entry of result.content) {
    if (isRecord(entry) && entry.type === 'text' && typeof entry.text === 'string') {
      parts.push(entry.text);
    } else if (isRecord(entry) && typeof entry.type === 'string') {
      parts.push(`[${entry.type}]`);
    }
  }
  const joined = parts.join('\n');
  const bounded = Buffer.from(joined, 'utf8').subarray(0, maxBytes).toString('utf8');
  return { summary: bounded, bytes: Buffer.byteLength(bounded) };
}

export async function createMcpToolProvider(input: unknown): Promise<McpToolProvider> {
  const config = typeof input === 'string' ? loadMcpConfig(input) : loadMcpConfig(input);
  interface Entry {
    readonly definition: ToolDefinition;
    readonly server: McpServerDeclaration;
    readonly connection: McpConnection;
    readonly remoteName: string;
  }
  const entries: Entry[] = [];
  const connections: McpConnection[] = [];
  try {
    for (const server of config.servers) {
      const connection = new McpConnection(server);
      connections.push(connection);
      await connection.initialize(server.startTimeoutMs ?? START_TIMEOUT_MS);
      const discovered = server.tools && server.tools.length > 0
        ? server.tools
        : (await connection.listTools(server.startTimeoutMs ?? START_TIMEOUT_MS))
          .map((tool) => ({
            name: tool.name,
            sideEffect: server.discoverySideEffect ?? ('read' as const),
            ...(tool.description ? { description: tool.description } : {}),
            ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
          }));
      for (const declared of discovered) {
        entries.push({
          definition: Object.freeze({
            id: `mcp_${server.id}_${declared.name.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase()}`,
            version: 1,
            description: declared.description?.slice(0, 512)
              ?? `MCP tool ${declared.name} from ${server.id}.`,
            sideEffect: declared.sideEffect,
            ...(declared.inputSchema ? { parameters: declared.inputSchema } : {}),
          }),
          server,
          connection,
          remoteName: declared.name,
        });
      }
    }
  } catch (cause) {
    await Promise.all(connections.map((connection) => connection.close()));
    throw cause;
  }

  const byId = new Map(entries.map((entry) => [entry.definition.id, entry]));
  return Object.freeze({
    list: () => Object.freeze(entries.map((entry) => entry.definition)),
    has: (toolId: string) => byId.has(toolId),
    invoke: (toolId: string, args: ToolArguments): Promise<ToolExecutionResult> => {
      const entry = byId.get(toolId);
      if (!entry) return Promise.reject(new ToolRejectedError('unknown_tool'));
      return (async () => {
        const result = await entry.connection.callTool(entry.remoteName, args, entry.server.callTimeoutMs ?? CALL_TIMEOUT_MS);
        const { summary, bytes } = summarize(result, entry.server.maxResultBytes ?? MAX_RESULT_BYTES);
        return Object.freeze({ ok: true, summary, digest: digest(summary), bytes });
      })();
    },
    async close() {
      await Promise.all(connections.map((connection) => connection.close()));
    },
  } as McpToolProvider);
}
