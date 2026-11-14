import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
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
const MAX_LINE_BYTES = 256 * 1024;
const SERVER_ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_.-]{1,64}$/;

export interface McpToolDeclaration {
  readonly name: string;
  readonly sideEffect: ToolSideEffect;
}

export interface McpServerDeclaration {
  readonly id: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly tools?: readonly McpToolDeclaration[];
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
  assertExactKeys(value, ['id', 'command', 'args', 'env', 'tools', 'startTimeoutMs', 'callTimeoutMs', 'maxResultBytes'], `servers[${index}]`);
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
      assertExactKeys(entry, ['name', 'sideEffect'], `servers[${index}].tools[${toolIndex}]`);
      if (typeof entry.name !== 'string' || !TOOL_NAME_PATTERN.test(entry.name)) {
        throw new ToolRejectedError('invalid_mcp_config', `servers[${index}].tools[${toolIndex}].name is invalid.`);
      }
      if (entry.sideEffect !== 'read' && entry.sideEffect !== 'write' && entry.sideEffect !== 'external') {
        throw new ToolRejectedError('invalid_mcp_config', `servers[${index}].tools[${toolIndex}].sideEffect is invalid.`);
      }
      return Object.freeze({ name: entry.name, sideEffect: entry.sideEffect });
    });
  }
  const boundedTimeout = (input: unknown, fallback: number): number =>
    typeof input === 'number' && Number.isInteger(input) && input >= 100 && input <= 60_000 ? input : fallback;
  const boundedBytes = (input: unknown, fallback: number): number =>
    typeof input === 'number' && Number.isInteger(input) && input >= 1 && input <= MAX_RESULT_BYTES ? input : fallback;
  return Object.freeze({
    id,
    command,
    args: Object.freeze([...value.args as string[]]),
    ...(env ? { env: Object.freeze(env) } : {}),
    ...(tools ? { tools: Object.freeze(tools) } : {}),
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

interface Pending {
  resolve(value: unknown): void;
  reject(cause: Error): void;
  timer: NodeJS.Timeout;
}

class McpConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = '';
  private closed = false;

  constructor(declaration: McpServerDeclaration) {
    this.child = spawn(declaration.command, [...declaration.args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      env: {
        PATH: '',
        NODE_OPTIONS: '',
        ...declaration.env,
      },
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onData(chunk));
    this.child.stderr.resume();
    this.child.once('exit', () => this.failAll('mcp_server_exited'));
  }

  async initialize(timeoutMs: number): Promise<void> {
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'conchbase', version: '1.0.0' },
    }, timeoutMs);
    this.notify('notifications/initialized', {});
  }

  async listTools(timeoutMs: number): Promise<readonly { name: string }[]> {
    const result = await this.request('tools/list', {}, timeoutMs);
    if (!isRecord(result) || !Array.isArray(result.tools)) throw new ToolRejectedError('mcp_invalid_response');
    return result.tools.flatMap((entry) =>
      isRecord(entry) && typeof entry.name === 'string' ? [{ name: entry.name }] : []);
  }

  async callTool(name: string, args: ToolArguments, timeoutMs: number): Promise<unknown> {
    return this.request('tools/call', { name, arguments: args }, timeoutMs);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failAll('mcp_server_closed');
    this.child.kill('SIGKILL');
  }

  private notify(method: string, params: unknown): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ToolRejectedError('mcp_timeout'));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new ToolRejectedError('mcp_write_failed'));
      }
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_LINE_BYTES) {
      this.failAll('mcp_response_too_large');
      return;
    }
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf('\n');
      if (line.length === 0) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let payload: unknown;
    try {
      payload = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(payload) || typeof payload.id !== 'number') return;
    const pending = this.pending.get(payload.id);
    if (!pending) return;
    this.pending.delete(payload.id);
    clearTimeout(pending.timer);
    if (payload.error !== undefined) {
      pending.reject(new ToolRejectedError('mcp_call_failed'));
      return;
    }
    pending.resolve(payload.result);
  }

  private failAll(code: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new ToolRejectedError(code));
      this.pending.delete(id);
    }
  }
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
          .map((tool) => ({ name: tool.name, sideEffect: 'read' as const }));
      for (const declared of discovered) {
        if (declared.sideEffect !== 'read') continue;
        entries.push({
          definition: Object.freeze({
            id: `mcp_${server.id}_${declared.name.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase()}`,
            version: 1,
            description: `MCP tool ${declared.name} from ${server.id}.`,
            sideEffect: 'read',
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
