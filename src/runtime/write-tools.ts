import { contentDigest } from './digest.js';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  ToolRejectedError,
  type ToolArguments,
  type ToolDefinition,
  type ToolExecutionResult,
  type ToolProvider,
} from './tool-provider.js';
import { requiredString } from './tool-parameter.js';

const MAX_WRITE_BYTES = 16 * 1024;
/** A recursive delete is bounded by what it can remove, not by time. */
const MAX_DELETE_ENTRIES = 500;


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
    Object.freeze({
      id: 'workspace_delete',
      version: 1,
      description: 'Delete one file or directory under the workspace root. A non-empty directory requires recursive: true. There is no undo.',
      sideEffect: 'write',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the workspace root.' },
          recursive: { type: 'boolean', description: 'Required to remove a non-empty directory.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    }),
    Object.freeze({
      id: 'workspace_move',
      version: 1,
      description: 'Move or rename a file or directory within the workspace root. Refuses to replace an existing target unless overwrite: true.',
      sideEffect: 'write',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Source path relative to the workspace root.' },
          to: { type: 'string', description: 'Destination path relative to the workspace root.' },
          overwrite: { type: 'boolean', description: 'Replace an existing destination.' },
        },
        required: ['from', 'to'],
        additionalProperties: false,
      },
    }),
    Object.freeze({
      id: 'workspace_copy',
      version: 1,
      description: 'Copy a file or directory within the workspace root. Refuses to replace an existing target unless overwrite: true.',
      sideEffect: 'write',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Source path relative to the workspace root.' },
          to: { type: 'string', description: 'Destination path relative to the workspace root.' },
          overwrite: { type: 'boolean', description: 'Replace an existing destination.' },
          recursive: { type: 'boolean', description: 'Copy a directory tree.' },
        },
        required: ['from', 'to'],
        additionalProperties: false,
      },
    }),
  ]);

  const write = (args: ToolArguments): ToolExecutionResult => {
    const relative = requiredString(args, 'path');
    const content = requiredString(args, 'content');
    if (Buffer.byteLength(content, 'utf8') > maxBytes) {
      throw new ToolRejectedError('content_too_large');
    }
    const target = resolveTarget(root, relative);
    let previousBytes = 0;
    try {
      const existing = statSync(target);
      if (existing.isDirectory()) throw new ToolRejectedError('target_is_directory');
      previousBytes = existing.size;
    } catch (cause) {
      if (cause instanceof ToolRejectedError) throw cause;
    }
    // Overwriting an existing file is a distinct, riskier action than creating
    // one. The model must say so explicitly, and the approval prompt names it.
    if (previousBytes > 0 && args.overwrite !== true) {
      throw new ToolRejectedError(
        'overwrite_requires_confirmation',
        'target already exists; pass overwrite: true to replace it.',
      );
    }
    try {
      mkdirSync(path.dirname(target), { recursive: true });
    } catch {
      throw new ToolRejectedError('parent_not_found');
    }
    writeFileSync(target, content, 'utf8');
    const bytes = Buffer.byteLength(content, 'utf8');
    return Object.freeze({
      ok: true,
      summary: previousBytes > 0
        ? `replaced ${relative} (${previousBytes} → ${bytes} bytes)`
        : `created ${relative} (${bytes} bytes)`,
      digest: contentDigest(content),
      bytes,
      evidence: { facts: { path: relative, created: previousBytes === 0, previousBytes, bytes } },
    });
  };

  /**
   * Deletes one path under the root.
   *
   * Three guards, because "delete" is the one operation with no recovery:
   * - the path must resolve inside the root, through the same check `write`
   *   uses (no absolute path, no `..`, no symlink escape);
   * - the workspace root itself is refused, which would otherwise be a
   *   single-call way to erase everything;
   * - a non-empty directory needs `recursive: true`, so an accidental
   *   `workspace_delete(".")` on a populated tree fails instead of succeeding.
   */
  const remove = (args: ToolArguments): ToolExecutionResult => {
    const relative = requiredString(args, 'path');
    const target = resolveTarget(root, relative);
    /*
     * Comparing against the *resolved* root, not the configured one.
     *
     * On macOS `/var` is a symlink to `/private/var`, so `resolveTarget('.')`
     * yields a path that is the same directory and a different string. Comparing
     * the strings let `workspace_delete(".")` through on exactly the platform
     * this runs on.
     */
    if (realpathSync(target) === realpathSync(root)) throw new ToolRejectedError('refuses_workspace_root');
    let stats;
    try {
      stats = statSync(target);
    } catch {
      throw new ToolRejectedError('not_found');
    }
    const isDirectory = stats.isDirectory();
    if (isDirectory) {
      const entries = readdirSync(target);
      if (entries.length > 0 && args.recursive !== true) {
        throw new ToolRejectedError(
          'recursive_requires_confirmation',
          'directory is not empty; pass recursive: true to remove it with its contents.',
        );
      }
      if (entries.length > MAX_DELETE_ENTRIES) {
        throw new ToolRejectedError('too_many_entries');
      }
    }
    const bytes = isDirectory ? 0 : stats.size;
    rmSync(target, { recursive: isDirectory, force: false });
    return Object.freeze({
      ok: true,
      summary: `deleted ${relative}${isDirectory ? ' (directory)' : ` (${bytes} bytes)`}`,
      digest: contentDigest(`delete:${relative}:${bytes}`),
      bytes,
      evidence: { facts: { path: relative, kind: isDirectory ? 'directory' : 'file', bytes } },
    });
  };

  /**
   * Moves a path within the root.
   *
   * `rename` is used rather than copy+delete: it is atomic on one filesystem, so
   * a crash leaves either the old name or the new one, never a half-written
   * duplicate. Both endpoints are checked against the root before anything
   * moves.
   */
  const move = (args: ToolArguments): ToolExecutionResult => {
    const from = requiredString(args, 'from');
    const to = requiredString(args, 'to');
    const source = resolveTarget(root, from);
    const destination = resolveTarget(root, to);
    const realRoot = realpathSync(root);
    if (existsSync(source) && realpathSync(source) === realRoot) {
      throw new ToolRejectedError('refuses_workspace_root');
    }
    if (existsSync(destination) && realpathSync(destination) === realRoot) {
      throw new ToolRejectedError('refuses_workspace_root');
    }
    if (source === destination) throw new ToolRejectedError('source_equals_destination');
    if (!existsSync(source)) throw new ToolRejectedError('not_found');
    if (existsSync(destination) && args.overwrite !== true) {
      throw new ToolRejectedError(
        'target_exists',
        'destination already exists; pass overwrite: true to replace it.',
      );
    }
    try {
      mkdirSync(path.dirname(destination), { recursive: true });
    } catch {
      throw new ToolRejectedError('parent_not_found');
    }
    renameSync(source, destination);
    return Object.freeze({
      ok: true,
      summary: `moved ${from} → ${to}`,
      digest: contentDigest(`move:${from}:${to}`),
      bytes: 0,
      evidence: { facts: { from, to } },
    });
  };

  /**
   * Copies a path within the root.
   *
   * Directory recursion is opt-in for the same reason delete's is: copying a
   * tree by accident is a large, slow, disk-filling action the model should
   * have to name.
   */
  const copy = (args: ToolArguments): ToolExecutionResult => {
    const from = requiredString(args, 'from');
    const to = requiredString(args, 'to');
    const source = resolveTarget(root, from);
    const destination = resolveTarget(root, to);
    if (source === destination) throw new ToolRejectedError('source_equals_destination');
    let stats;
    try {
      stats = statSync(source);
    } catch {
      throw new ToolRejectedError('not_found');
    }
    const isDirectory = stats.isDirectory();
    if (isDirectory && args.recursive !== true) {
      throw new ToolRejectedError(
        'recursive_requires_confirmation',
        'source is a directory; pass recursive: true to copy it with its contents.',
      );
    }
    if (existsSync(destination) && args.overwrite !== true) {
      throw new ToolRejectedError(
        'target_exists',
        'destination already exists; pass overwrite: true to replace it.',
      );
    }
    try {
      mkdirSync(path.dirname(destination), { recursive: true });
    } catch {
      throw new ToolRejectedError('parent_not_found');
    }
    if (isDirectory) cpSync(source, destination, { recursive: true, force: args.overwrite === true });
    else copyFileSync(source, destination);
    return Object.freeze({
      ok: true,
      summary: `copied ${from} → ${to}${isDirectory ? ' (directory)' : ''}`,
      digest: contentDigest(`copy:${from}:${to}`),
      bytes: isDirectory ? 0 : stats.size,
      evidence: { facts: { from, to, kind: isDirectory ? 'directory' : 'file' } },
    });
  };

  return Object.freeze({
    list: () => definitions,
    has: (toolId: string) => definitions.some((definition) => definition.id === toolId),
    invoke: (toolId: string, args: ToolArguments) => {
      switch (toolId) {
        case 'workspace_write': return write(args);
        case 'workspace_delete': return remove(args);
        case 'workspace_move': return move(args);
        case 'workspace_copy': return copy(args);
        default: throw new ToolRejectedError('unknown_tool');
      }
    },
  });
}
