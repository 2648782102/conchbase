/**
 * Per-worktree isolation for parallel Codex sessions.
 *
 * Several sessions can check out different branches of this repository and run
 * a Runtime at the same time. Two things must never be shared between them:
 *
 *   1. the TCP port, because the second process would simply fail to bind;
 *   2. the SQLite database, because one Runtime must own exactly one file
 *      and two sessions must not fight over the same rows.
 *
 * Both are derived deterministically from the checkout, so a session never has
 * to remember an assigned number. The main checkout keeps the historical
 * defaults so existing docs and muscle memory stay valid.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_PORT = 4318;
const PARALLEL_PORT_START = 4320;
const PARALLEL_PORT_COUNT = 80;

function safeGit(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

/**
 * A short, stable, filename-safe slug for this checkout. Uses the branch name
 * when there is one, because that is what a human associates with the session;
 * falls back to the directory name for a detached checkout.
 */
export function worktreeSlug(root) {
  const branch = safeGit(['rev-parse', '--abbrev-ref', 'HEAD'], root);
  const source = branch && branch !== 'HEAD' ? branch : path.basename(root);
  const slug = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug.length > 0 ? slug : 'default';
}

function hashToPort(seed) {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return PARALLEL_PORT_START + (hash % PARALLEL_PORT_COUNT);
}

/**
 * True when this checkout is the repository's main working tree. The main tree
 * keeps port 4318 and `.conchbase/runtime.sqlite`; every linked worktree gets
 * its own port and its own database directory.
 */
export function isMainWorktree(root) {
  const common = safeGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], root);
  const gitDir = safeGit(['rev-parse', '--path-format=absolute', '--git-dir'], root);
  return common.length > 0 && gitDir.length > 0 && common === gitDir;
}

export function resolveWorktreeEnv(root = process.cwd(), env = process.env) {
  const main = isMainWorktree(root);
  const slug = worktreeSlug(root);
  const port = main
    ? DEFAULT_PORT
    : Number(env.CONCHBASE_PORT ?? env.PORT ?? hashToPort(slug));
  const host = env.CONCHBASE_HOST ?? env.HOST ?? '127.0.0.1';
  const databasePath = env.CONCHBASE_DB
    ?? (main
      ? path.join(root, '.conchbase', 'runtime.sqlite')
      : path.join(root, '.conchbase', slug, 'runtime.sqlite'));
  const workspaceRoot = env.CONCHBASE_WORKSPACE_ROOT
    ?? (main ? root : path.join(root, '.conchbase', slug, 'workspace'));
  return Object.freeze({ main, slug, host, port, databasePath, workspaceRoot });
}

/**
 * Writes `.conchbase/session.json` so a human can look at one checkout and see
 * which port it owns without reading the script.
 */
export function writeSessionMarker(root, env) {
  const directory = path.join(root, '.conchbase');
  try {
    mkdirSync(directory, { recursive: true });
    const marker = path.join(directory, 'session.json');
    const existing = existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')) : {};
    const next = { ...existing, ...env, updatedAt: new Date().toISOString() };
    writeFileSync(marker, `${JSON.stringify(next, null, 2)}\n`);
  } catch {
    // The marker is a convenience, never a requirement to boot.
  }
}
