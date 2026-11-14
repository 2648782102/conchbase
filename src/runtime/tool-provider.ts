import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export type ToolSideEffect = 'read' | 'write' | 'external';

export type ToolScalar = string | number | boolean | null;
export type ToolArguments = Readonly<Record<string, ToolScalar>>;

export interface ToolDefinition {
  readonly id: string;
  readonly version: 1;
  readonly description: string;
  readonly sideEffect: ToolSideEffect;
}

export interface ToolExecutionResult {
  readonly ok: boolean;
  readonly summary: string;
  readonly digest: string;
  readonly bytes: number;
  readonly errorCode?: string;
}

export interface ToolProvider {
  list(): readonly ToolDefinition[];
  has(toolId: string): boolean;
  invoke(toolId: string, args: ToolArguments): ToolExecutionResult;
}

export class ToolRejectedError extends Error {
  constructor(readonly code: string, message = 'Tool call was rejected.') {
    super(message);
    this.name = 'ToolRejectedError';
  }
}

const DEFAULT_MAX_BYTES = 8_192;
const MAX_ENTRIES = 200;
const MAX_MATCHES = 40;

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function asString(args: ToolArguments, key: string, fallback = ''): string {
  const value = args[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new ToolRejectedError('invalid_arguments', `${key} must be a string.`);
  return value;
}

function asInteger(args: ToolArguments, key: string, fallback: number, max: number): number {
  const value = args[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new ToolRejectedError('invalid_arguments', `${key} must be a positive integer.`);
  }
  return Math.min(value, max);
}

function resolveInsideRoot(root: string, relative: string): string {
  if (relative.includes('\0')) throw new ToolRejectedError('invalid_path');
  const normalizedRoot = path.resolve(root);
  const target = path.resolve(normalizedRoot, relative);
  if (target !== normalizedRoot && !target.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new ToolRejectedError('path_escapes_root');
  }
  return target;
}

export function createBuiltinReadTools(options: {
  readonly root: string;
  readonly maxBytes?: number;
}): ToolProvider {
  const root = path.resolve(options.root);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  const definitions: readonly ToolDefinition[] = Object.freeze([
    Object.freeze({
      id: 'text_search',
      version: 1,
      description: 'Search a bounded directory for a literal pattern and return bounded matches.',
      sideEffect: 'read',
    }),
    Object.freeze({
      id: 'workspace_list',
      version: 1,
      description: 'List bounded entries under an allowed directory.',
      sideEffect: 'read',
    }),
    Object.freeze({
      id: 'workspace_read',
      version: 1,
      description: 'Read a bounded UTF-8 text slice of an allowed file.',
      sideEffect: 'read',
    }),
  ]);

  function list(args: ToolArguments): ToolExecutionResult {
    const relative = asString(args, 'path', '.');
    const target = resolveInsideRoot(root, relative);
    const limit = asInteger(args, 'limit', 50, MAX_ENTRIES);
    let stats;
    try {
      stats = statSync(target);
    } catch {
      throw new ToolRejectedError('not_found');
    }
    if (!stats.isDirectory()) throw new ToolRejectedError('not_a_directory');
    const entries = readdirSync(target, { withFileTypes: true })
      .slice(0, limit)
      .map((entry) => {
        const full = path.join(target, entry.name);
        const size = entry.isFile() ? statSync(full).size : null;
        return { name: entry.name, kind: entry.isDirectory() ? 'dir' : 'file', size };
      });
    const summary = entries.map((entry) => `${entry.kind}\t${entry.name}\t${entry.size ?? '-'}`).join('\n');
    return Object.freeze({ ok: true, summary, digest: digest(summary), bytes: summary.length });
  }

  function read(args: ToolArguments): ToolExecutionResult {
    const relative = asString(args, 'path');
    if (relative.length === 0) throw new ToolRejectedError('invalid_arguments', 'path is required.');
    const target = resolveInsideRoot(root, relative);
    const maxChars = Math.min(asInteger(args, 'maxBytes', maxBytes, maxBytes), maxBytes);
    let stats;
    try {
      stats = statSync(target);
    } catch {
      throw new ToolRejectedError('not_found');
    }
    if (!stats.isFile()) throw new ToolRejectedError('not_a_file');
    const buffer = readFileSync(target);
    const slice = buffer.subarray(0, maxChars).toString('utf8');
    return Object.freeze({ ok: true, summary: slice, digest: digest(slice), bytes: Buffer.byteLength(slice) });
  }

  function search(args: ToolArguments): ToolExecutionResult {
    const pattern = asString(args, 'pattern');
    if (pattern.length === 0) throw new ToolRejectedError('invalid_arguments', 'pattern is required.');
    const relative = asString(args, 'path', '.');
    const start = resolveInsideRoot(root, relative);
    const matches: string[] = [];
    const visit = (directory: string): void => {
      if (matches.length >= MAX_MATCHES) return;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (matches.length >= MAX_MATCHES) return;
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          visit(full);
          continue;
        }
        if (!entry.isFile()) continue;
        if (statSync(full).size > maxBytes) continue;
        const text = readFileSync(full).toString('utf8');
        if (!text.includes(pattern)) continue;
        matches.push(path.relative(root, full).split(path.sep).join('/'));
      }
    };
    visit(start);
    const summary = matches.join('\n');
    return Object.freeze({ ok: true, summary, digest: digest(summary), bytes: summary.length });
  }

  const handlers: Readonly<Record<string, (args: ToolArguments) => ToolExecutionResult>> = Object.freeze({
    'text_search': search,
    'workspace_list': list,
    'workspace_read': read,
  });

  return Object.freeze({
    list: () => definitions,
    has: (toolId: string) => Object.prototype.hasOwnProperty.call(handlers, toolId),
    invoke: (toolId: string, args: ToolArguments) => {
      const handler = handlers[toolId];
      if (!handler) throw new ToolRejectedError('unknown_tool');
      return handler(args);
    },
  });
}
