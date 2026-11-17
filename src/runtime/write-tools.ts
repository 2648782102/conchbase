import { createHash } from 'node:crypto';
import { closeSync, constants, lstatSync, openSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  ToolRejectedError,
  type ToolArguments,
  type ToolDefinition,
  type ToolExecutionResult,
  type ToolProvider,
} from './tool-provider.js';

const MAX_WRITE_BYTES = 16 * 1024;

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function asString(args: ToolArguments, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ToolRejectedError('invalid_arguments', `${key} must be a non-empty string.`);
  }
  return value;
}

function resolveTarget(root: string, relative: string): string {
  if (relative.includes('\0') || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) {
    throw new ToolRejectedError('path_escapes_root');
  }
  const normalizedRoot = path.resolve(root);
  const target = path.resolve(normalizedRoot, relative);
  if (target !== normalizedRoot && !target.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new ToolRejectedError('path_escapes_root');
  }
  const parent = path.dirname(target);
  try {
    const realRoot = realpathSync(normalizedRoot);
    const realParent = realpathSync(parent);
    if (realParent !== realRoot && !realParent.startsWith(`${realRoot}${path.sep}`)) {
      throw new ToolRejectedError('path_escapes_root');
    }
  } catch (cause) {
    if (cause instanceof ToolRejectedError) throw cause;
    throw new ToolRejectedError('parent_not_found');
  }
  return target;
}

export function createBuiltinWriteTools(options: {
  readonly root: string;
  readonly maxBytes?: number;
}): ToolProvider {
  const root = path.resolve(options.root);
  const maxBytes = options.maxBytes ?? MAX_WRITE_BYTES;
  const definitions: readonly ToolDefinition[] = Object.freeze([
    Object.freeze({
      id: 'workspace_write',
      version: 1,
      description: 'Write bounded UTF-8 text to an existing directory under the workspace root.',
      sideEffect: 'write',
    }),
  ]);

  const write = (args: ToolArguments): ToolExecutionResult => {
    const relative = asString(args, 'path');
    const content = asString(args, 'content');
    if (Buffer.byteLength(content, 'utf8') > maxBytes) {
      throw new ToolRejectedError('content_too_large');
    }
    const target = resolveTarget(root, relative);
    try {
      if (statSync(target).isDirectory()) throw new ToolRejectedError('target_is_directory');
    } catch (cause) {
      if (cause instanceof ToolRejectedError) throw cause;
    }
    // `resolveTarget` only proves the *parent* directory is inside the root. A
    // symlinked file at the target would still be followed, so a workspace
    // containing `note.txt -> /etc/passwd` escaped the root with a plain
    // writeFileSync. O_NOFOLLOW makes the open reject that link atomically
    // instead of relying on a check-then-act window.
    let existing;
    try {
      existing = lstatSync(target);
    } catch {
      existing = undefined;
    }
    if (existing?.isSymbolicLink()) throw new ToolRejectedError('path_escapes_root');
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC
      | (constants.O_NOFOLLOW ?? 0);
    const handle = openSync(target, flags, 0o600);
    try {
      writeFileSync(handle, content, 'utf8');
    } finally {
      closeSync(handle);
    }
    return Object.freeze({
      ok: true,
      summary: `wrote ${Buffer.byteLength(content, 'utf8')} bytes`,
      digest: digest(content),
      bytes: Buffer.byteLength(content, 'utf8'),
    });
  };

  return Object.freeze({
    list: () => definitions,
    has: (toolId: string) => toolId === 'workspace_write',
    invoke: (toolId: string, args: ToolArguments) => {
      if (toolId !== 'workspace_write') throw new ToolRejectedError('unknown_tool');
      return write(args);
    },
  });
}
