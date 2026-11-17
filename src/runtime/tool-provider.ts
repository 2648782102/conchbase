import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pageToolResult } from './tool-result-paging.js';

export type ToolSideEffect = 'read' | 'write' | 'external';

export type ToolScalar = string | number | boolean | null;
export type ToolArguments = Readonly<Record<string, ToolScalar>>;

/**
 * A bounded, JSON-Schema-shaped parameter description handed to the model.
 * It is data, not validation: the Runtime still rejects arguments that do not
 * fit the tool's own checks.
 */
export type ToolParameterSchema = Readonly<Record<string, unknown>>;

export interface ToolDefinition {
  readonly id: string;
  readonly version: 1;
  readonly description: string;
  readonly sideEffect: ToolSideEffect;
  readonly parameters?: ToolParameterSchema;
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
  invoke(toolId: string, args: ToolArguments): ToolExecutionResult | Promise<ToolExecutionResult>;
}

export class ToolRejectedError extends Error {
  constructor(readonly code: string, message = 'Tool call was rejected.') {
    super(message);
    this.name = 'ToolRejectedError';
  }
}

export function combineToolProviders(providers: readonly ToolProvider[]): ToolProvider {
  const all = providers.flatMap((provider) => [...provider.list()]);
  const ids = new Set(all.map((tool) => tool.id));
  if (ids.size !== all.length) throw new ToolRejectedError('duplicate_tool');
  return Object.freeze({
    list: () => Object.freeze(all),
    has: (toolId: string) => providers.some((provider) => provider.has(toolId)),
    invoke: async (toolId: string, args: ToolArguments) => {
      const provider = providers.find((candidate) => candidate.has(toolId));
      if (!provider) throw new ToolRejectedError('unknown_tool');
      return provider.invoke(toolId, args);
    },
  });
}

const DEFAULT_MAX_BYTES = 8_192;
const MAX_ENTRIES = 200;
const MAX_MATCHES = 40;
/** Walk budgets so one search cannot monopolise the event loop. */
const MAX_SEARCH_DEPTH = 12;
const MAX_SEARCH_DIRECTORIES = 2_000;
const MAX_SEARCH_FILES = 5_000;
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.turbo']);

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function asString(args: ToolArguments, key: string, fallback = ''): string {
  const value = args[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new ToolRejectedError('invalid_arguments', `${key} must be a string.`);
  return value;
}

function asInteger(
  args: ToolArguments,
  key: string,
  fallback: number,
  max: number,
  allowZero = false,
): number {
  const value = args[key];
  if (value === undefined) return fallback;
  const minimum = allowZero ? 0 : 1;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
    throw new ToolRejectedError(
      'invalid_arguments',
      `${key} must be a ${allowZero ? 'non-negative' : 'positive'} integer.`,
    );
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
  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = realpathSync(normalizedRoot);
    realTarget = realpathSync(target);
  } catch {
    // Missing paths are reported by the calling tool with a bounded code.
    return target;
  }
  if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}${path.sep}`)) {
    throw new ToolRejectedError('path_escapes_root');
  }
  return realTarget;
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
      description: 'Search a bounded directory for a literal pattern. Results are capped; a truncation notice explains how to narrow the search.',
      sideEffect: 'read',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory relative to the workspace root. Defaults to "."' },
          pattern: { type: 'string', description: 'Literal text to find.' },
        },
        required: ['pattern'],
      },
    }),
    Object.freeze({
      id: 'workspace_list',
      version: 1,
      description: 'List bounded entries under an allowed directory. Use path and limit to narrow or widen the listing.',
      sideEffect: 'read',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory relative to the workspace root. Defaults to "."' },
          offset: { type: 'integer', minimum: 0, description: 'Entry offset to start from. Defaults to 0.' },
          limit: { type: 'integer', minimum: 1, description: 'Maximum entries to return. Defaults to 50.' },
        },
      },
    }),
    Object.freeze({
      id: 'workspace_read',
      version: 1,
      description: 'Read a bounded UTF-8 text slice of an allowed file. Truncated reads state the next offset to pass.',
      sideEffect: 'read',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File relative to the workspace root.' },
          offset: { type: 'integer', minimum: 0, description: 'Byte offset to start from. Defaults to 0.' },
          maxBytes: { type: 'integer', minimum: 1, description: 'Byte budget for this slice.' },
        },
        required: ['path'],
      },
    }),
  ]);

  function list(args: ToolArguments): ToolExecutionResult {
    const relative = asString(args, 'path', '.');
    const target = resolveInsideRoot(root, relative);
    const offset = asInteger(args, 'offset', 0, MAX_ENTRIES, true);
    const limit = asInteger(args, 'limit', 50, MAX_ENTRIES);
    let stats;
    try {
      stats = statSync(target);
    } catch {
      throw new ToolRejectedError('not_found');
    }
    if (!stats.isDirectory()) throw new ToolRejectedError('not_a_directory');
    const all = readdirSync(target, { withFileTypes: true });
    const entries = all
      .slice(offset, offset + limit)
      .map((entry) => {
        const full = path.join(target, entry.name);
        const size = entry.isFile() ? statSync(full).size : null;
        return { name: entry.name, kind: entry.isDirectory() ? 'dir' : 'file', size };
      });
    const raw = entries.map((entry) => `${entry.kind}\t${entry.name}\t${entry.size ?? '-'}`).join('\n');
    const hasMore = offset + entries.length < all.length;
    const paged = pageToolResult({
      text: raw,
      maxBytes,
      ...(hasMore
        ? {
          continuation: {
            argument: 'offset',
            nextValue: offset + entries.length,
            unit: 'item' as const,
          },
        }
        : {}),
    });
    const footer = hasMore && !paged.truncated
      ? `\n\n[more entries available. Continue with offset=${offset + entries.length}.]`
      : '';
    const summary = `${paged.summary}${footer}`;
    return Object.freeze({ ok: true, summary, digest: digest(summary), bytes: Buffer.byteLength(summary) });
  }

  function read(args: ToolArguments): ToolExecutionResult {
    const relative = asString(args, 'path');
    if (relative.length === 0) throw new ToolRejectedError('invalid_arguments', 'path is required.');
    const target = resolveInsideRoot(root, relative);
    const offset = asInteger(args, 'offset', 0, Number.MAX_SAFE_INTEGER, true);
    const requested = args.maxBytes;
    if (requested !== undefined && (typeof requested !== 'number' || !Number.isInteger(requested) || requested < 1)) {
      throw new ToolRejectedError('invalid_arguments', 'maxBytes must be a positive integer.');
    }
    if (typeof requested === 'number' && requested > maxBytes) {
      throw new ToolRejectedError('byte_cap_exceeded');
    }
    const maxChars = requested ?? maxBytes;
    let stats;
    try {
      stats = statSync(target);
    } catch {
      throw new ToolRejectedError('not_found');
    }
    if (!stats.isFile()) throw new ToolRejectedError('not_a_file');
    if (offset > stats.size) throw new ToolRejectedError('offset_out_of_range');
    // Read only the requested window, plus one byte so truncation stays
    // observable. `maxBytes` used to cap the answer but not the work: pointing
    // this at a multi-gigabyte log allocated the entire file before slicing
    // 8 KiB out of it.
    const remaining = Math.max(stats.size - offset, 0);
    const windowSize = Math.min(maxChars + 1, remaining);
    const buffer = Buffer.allocUnsafe(windowSize);
    const handle = openSync(target, 'r');
    let filled = 0;
    try {
      while (filled < windowSize) {
        const read = readSync(handle, buffer, filled, windowSize - filled, offset + filled);
        if (read === 0) break;
        filled += read;
      }
    } finally {
      closeSync(handle);
    }
    const paged = pageToolResult({
      text: buffer.subarray(0, filled).toString('utf8'),
      maxBytes: maxChars,
      continuation: {
        argument: 'offset',
        nextValue: offset + maxChars,
        unit: 'byte',
        totalBytes: remaining,
      },
    });
    // The continuation must point at a byte boundary that exists in the file.
    const nextOffset = Math.min(offset + maxChars, stats.size);
    const summary = paged.truncated
      ? paged.summary.replace(
        /Continue with offset=\d+\./,
        `Continue with offset=${nextOffset}.`,
      )
      : paged.summary;
    return Object.freeze({
      ok: true,
      summary,
      digest: digest(summary),
      bytes: Buffer.byteLength(summary),
    });
  }

  /**
   * Bounded, asynchronous search.
   *
   * The previous version used readdirSync/readFileSync recursively, so one call
   * inside a workspace containing node_modules blocked the event loop for
   * seconds — no HTTP request and no other task could progress. It also had no
   * depth, entry, or byte budget, only a match cap.
   */
  async function search(args: ToolArguments): Promise<ToolExecutionResult> {
    const pattern = asString(args, 'pattern');
    if (pattern.length === 0) throw new ToolRejectedError('invalid_arguments', 'pattern is required.');
    const relative = asString(args, 'path', '.');
    const start = resolveInsideRoot(root, relative);
    const matches: string[] = [];
    let visitedFiles = 0;
    let visitedDirectories = 0;
    let exhausted = false;

    const visit = async (directory: string, depth: number): Promise<void> => {
      if (matches.length >= MAX_MATCHES || exhausted) return;
      if (depth > MAX_SEARCH_DEPTH || visitedDirectories >= MAX_SEARCH_DIRECTORIES) {
        exhausted = true;
        return;
      }
      visitedDirectories += 1;
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (matches.length >= MAX_MATCHES || exhausted) return;
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(full, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        if (visitedFiles >= MAX_SEARCH_FILES) {
          exhausted = true;
          return;
        }
        visitedFiles += 1;
        let size: number;
        try {
          size = statSync(full).size;
        } catch {
          continue;
        }
        if (size > maxBytes) continue;
        let text: string;
        try {
          const handle = openSync(full, 'r');
          try {
            const buffer = Buffer.allocUnsafe(size);
            const filled = readSync(handle, buffer, 0, size, 0);
            text = buffer.subarray(0, filled).toString('utf8');
          } finally {
            closeSync(handle);
          }
        } catch {
          continue;
        }
        if (!text.includes(pattern)) continue;
        matches.push(path.relative(root, full).split(path.sep).join('/'));
      }
    };

    await visit(start, 0);
    const raw = matches.join('\n');
    const paged = pageToolResult({ text: raw, maxBytes });
    const capped = matches.length >= MAX_MATCHES;
    const reason = capped
      ? `match cap reached at ${MAX_MATCHES}`
      : exhausted
        ? `search budget reached after ${visitedFiles} files`
        : null;
    const footer = reason !== null && !paged.truncated
      ? `\n\n[${reason}; narrow the pattern or path to see more.]`
      : '';
    const summary = `${paged.summary}${footer}`;
    return Object.freeze({ ok: true, summary, digest: digest(summary), bytes: Buffer.byteLength(summary) });
  }

  const handlers: Readonly<Record<string, (args: ToolArguments) => ToolExecutionResult | Promise<ToolExecutionResult>>> = Object.freeze({
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
