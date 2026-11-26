import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * A bounded, read-only index of the workspace, for a client's `@` picker.
 *
 * The Runtime already exposes `workspace_list` and `workspace_read` as Agent
 * tools, but a tool is something the model decides to call. A person typing a
 * message needs the opposite: a list of candidate paths *before* sending, so
 * they can point at a file instead of describing it. Neither the model nor the
 * client may walk the filesystem themselves — the client boundary forbids it
 * and the model boundary is untrusted input — so the Runtime answers.
 *
 * This is an index, not a browser. It returns paths and sizes only, never
 * contents, and it stops at hard caps so one keystroke cannot walk a monorepo:
 * fixed entry budget, fixed depth, a small deny-list of directories that are
 * large and never interesting to quote, and a per-file size ceiling so the
 * picker does not offer files the message cannot carry.
 */

export const WORKSPACE_INDEX_MAX_ENTRIES = 200;
export const WORKSPACE_INDEX_MAX_DEPTH = 6;
/** Files above this are not offered: the message could not quote them. */
export const WORKSPACE_INDEX_MAX_FILE_BYTES = 192 * 1024;

const SKIPPED_DIRECTORIES = Object.freeze(new Set([
  '.git', '.hg', '.svn', 'node_modules', 'dist', 'build', '.next', '.cache',
  '.venv', 'venv', '__pycache__', '.turbo', 'coverage', 'target', '.idea',
]));

export interface WorkspaceFileEntry {
  /** POSIX-style path relative to the workspace root. */
  readonly path: string;
  readonly bytes: number;
  /** Directory that contains the file, for grouping in the picker. */
  readonly directory: string;
}

export interface WorkspaceFileIndex {
  readonly files: readonly WorkspaceFileEntry[];
  /** True when the walk stopped at the entry budget. */
  readonly truncated: boolean;
}

export class WorkspaceIndexError extends Error {
  constructor(readonly code: 'missing_root' | 'not_a_directory', message: string) {
    super(message);
    this.name = 'WorkspaceIndexError';
  }
}

/**
 * Walks the workspace breadth-first so the closest files are found first.
 *
 * Depth-first would descend into the first deep directory it meets and spend
 * the whole budget there; breadth-first keeps the result legible when the cap
 * is reached, which is the common case in a real repository.
 */
export function indexWorkspaceFiles(
  root: string,
  options: { readonly query?: string; readonly limit?: number } = {},
): WorkspaceFileIndex {
  const limit = Math.min(
    options.limit === undefined ? 50 : Math.max(1, options.limit),
    WORKSPACE_INDEX_MAX_ENTRIES,
  );
  const query = (options.query ?? '').trim().toLowerCase();

  let rootStats;
  try {
    rootStats = statSync(root);
  } catch {
    throw new WorkspaceIndexError('missing_root', 'Workspace root does not exist.');
  }
  if (!rootStats.isDirectory()) {
    throw new WorkspaceIndexError('not_a_directory', 'Workspace root is not a directory.');
  }

  const files: WorkspaceFileEntry[] = [];
  let truncated = false;
  let visited = 0;
  const queue: { readonly absolute: string; readonly relative: string; readonly depth: number }[] = [
    { absolute: root, relative: '', depth: 0 },
  ];

  while (queue.length > 0 && files.length < limit) {
    const current = queue.shift()!;
    let entries;
    try {
      entries = readdirSync(current.absolute, { withFileTypes: true });
    } catch {
      // An unreadable directory is skipped rather than failing the whole
      // index: one permission bit should not empty the picker.
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      visited += 1;
      if (visited > WORKSPACE_INDEX_MAX_ENTRIES * 40) {
        truncated = true;
        break;
      }
      const relative = current.relative === '' ? entry.name : `${current.relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        if (entry.name.startsWith('.') && entry.name !== '.github') continue;
        if (current.depth + 1 > WORKSPACE_INDEX_MAX_DEPTH) continue;
        queue.push({ absolute: path.join(current.absolute, entry.name), relative, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      if (query.length > 0 && !relative.toLowerCase().includes(query)) continue;
      let bytes: number;
      try {
        bytes = statSync(path.join(current.absolute, entry.name)).size;
      } catch {
        continue;
      }
      if (bytes > WORKSPACE_INDEX_MAX_FILE_BYTES) continue;
      files.push(
        Object.freeze({
          path: relative,
          bytes,
          directory: current.relative,
        }),
      );
      if (files.length >= limit) {
        truncated = queue.length > 0 || entries.length > 0;
        break;
      }
    }
    if (truncated) break;
  }

  return Object.freeze({ files: Object.freeze(files), truncated });
}
