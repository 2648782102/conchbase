import { optionalString } from './tool-parameter.js';
import { contentDigest } from './digest.js';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { pageToolResult } from './tool-result-paging.js';

export type ToolSideEffect = 'read' | 'write' | 'external';

/**
 * The shape of a tool id, wherever the tool comes from.
 *
 * It lived in the plugin manifest, which meant only plugin and MCP tools were
 * ever checked — a built-in with a malformed id would have reached the model
 * unchecked. The id appears in model-visible prompts and in event data, so the
 * rule belongs to the tool contract rather than to one provider.
 */
export const TOOL_ID_PATTERN = /^[a-z][a-z0-9_.-]{1,63}$/;

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

export interface ToolEvidence {
  /** Human-readable facts the model can cite: counts, paths, sizes. */
  readonly facts: Readonly<Record<string, string | number | boolean>>;
}

export interface ToolExecutionResult {
  readonly ok: boolean;
  readonly summary: string;
  readonly digest: string;
  readonly bytes: number;
  /** True when the summary is a bounded slice of a larger result. */
  readonly truncated?: boolean;
  readonly evidence?: ToolEvidence;
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
  // Every provider is merged here, so this is the one place that can check the
  // whole surface. Duplicate ids were already refused; a malformed id was not,
  // because the pattern lived in the plugin manifest and built-ins never saw it.
  const malformed = all.filter((tool) => !TOOL_ID_PATTERN.test(tool.id));
  if (malformed.length > 0) {
    throw new ToolRejectedError(
      'invalid_tool_id',
      `tool ids must match ${TOOL_ID_PATTERN.source}: ${malformed.map((tool) => tool.id).join(', ')}`,
    );
  }
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
const MAX_SEARCH_DEPTH = 8;
const SEARCH_TIME_BUDGET_MS = 2_000;


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
    const relative = optionalString(args, 'path', '.');
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
    return Object.freeze({
      ok: true, summary, digest: contentDigest(summary), bytes: Buffer.byteLength(summary),
      truncated: paged.truncated || hasMore,
      evidence: { facts: { path: relative, totalEntries: all.length, returned: entries.length, hasMore } },
    });
  }

  function read(args: ToolArguments): ToolExecutionResult {
    const relative = optionalString(args, 'path');
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
    const buffer = readFileSync(target);
    if (offset > buffer.length) throw new ToolRejectedError('offset_out_of_range');
    const window = buffer.subarray(offset);
    const paged = pageToolResult({
      text: window.toString('utf8'),
      maxBytes: maxChars,
      continuation: { argument: 'offset', nextValue: offset + maxChars, unit: 'byte' },
    });
    // The continuation must point at a byte boundary that exists in the file.
    const nextOffset = Math.min(offset + maxChars, buffer.length);
    const summary = paged.truncated
      ? paged.summary.replace(
        /Continue with offset=\d+\./,
        `Continue with offset=${nextOffset}.`,
      )
      : paged.summary;
    return Object.freeze({
      ok: true,
      summary,
      digest: contentDigest(summary),
      bytes: Buffer.byteLength(summary),
      truncated: paged.truncated,
      evidence: { facts: { path: relative, totalBytes: buffer.length, offset, truncated: paged.truncated } },
    });
  }

  function search(args: ToolArguments): ToolExecutionResult {
    const pattern = optionalString(args, 'pattern');
    if (pattern.length === 0) throw new ToolRejectedError('invalid_arguments', 'pattern is required.');
    const relative = optionalString(args, 'path', '.');
    const start = resolveInsideRoot(root, relative);
    const matches: string[] = [];
    const deadline = Date.now() + SEARCH_TIME_BUDGET_MS;
    let timedOut = false;
    let tooDeep = false;
    const visit = (directory: string, depth: number): void => {
      if (matches.length >= MAX_MATCHES || Date.now() > deadline) {
        if (Date.now() > deadline) timedOut = true;
        return;
      }
      if (depth > MAX_SEARCH_DEPTH) { tooDeep = true; return; }
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (matches.length >= MAX_MATCHES || Date.now() > deadline) {
          if (Date.now() > deadline) timedOut = true;
          return;
        }
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          visit(full, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        if (statSync(full).size > maxBytes) continue;
        const text = readFileSync(full).toString('utf8');
        if (!text.includes(pattern)) continue;
        matches.push(path.relative(root, full).split(path.sep).join('/'));
      }
    };
    visit(start, 0);
    const raw = matches.join('\n');
    const paged = pageToolResult({ text: raw, maxBytes });
    const capped = matches.length >= MAX_MATCHES;
    const notices: string[] = [];
    if (capped && !paged.truncated) notices.push(`[match cap reached at ${MAX_MATCHES}; narrow the pattern or path to see more.]`);
    if (timedOut) notices.push(`[search stopped after ${SEARCH_TIME_BUDGET_MS}ms; narrow the path to finish faster.]`);
    if (tooDeep) notices.push(`[search stopped at depth ${MAX_SEARCH_DEPTH}; start from a deeper path.]`);
    const footer = notices.length > 0 ? `\n\n${notices.join('\n')}` : '';
    const summary = `${paged.summary}${footer}`;
    return Object.freeze({
      ok: true, summary, digest: contentDigest(summary), bytes: Buffer.byteLength(summary),
      truncated: paged.truncated || capped || timedOut || tooDeep,
      evidence: { facts: { path: relative, pattern, matches: matches.length, capped, timedOut, tooDeep } },
    });
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
