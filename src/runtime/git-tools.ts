import { referenceDigest } from './digest.js';
import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import { ProcessSpecError, resolveProgram, validateProcessSpec } from '../kernel/process-spec.js';
import { ToolRejectedError, type ToolArguments, type ToolExecutionResult, type ToolProvider } from './tool-provider.js';
import { requiredString } from './tool-parameter.js';

/**
 * Read-only git tools.
 *
 * Everything here is deliberately narrow: three fixed subcommands, no shell, no
 * model-supplied flags, and a hard byte cap. A model can ask "what changed" and
 * nothing else — there is no path from this module to `git commit`, `git push`,
 * or arbitrary argv.
 *
 * The tools are opt-in because they execute a subprocess. Every other built-in
 * tool is a filesystem call; keeping subprocess execution behind an explicit
 * flag preserves that default.
 */

const MAX_OUTPUT_BYTES = 64_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_COMMITS = 20;
const MAX_COMMITS = 100;

export interface GitToolsOptions {
  readonly root: string;
  /**
   * Absolute path to the git binary.
   *
   * When omitted it is resolved once from `PATH` so a machine that installs git
   * somewhere other than `/usr/bin` still works. Resolution happens at
   * construction, not per call: the process must not be able to observe a PATH
   * that changed underneath it.
   */
  readonly gitBinary?: string;
  /** The PATH to resolve `git` from; defaults to the ambient one. */
  readonly searchPath?: string;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  /** Injected for tests: resolves the binary, or throws when unavailable. */
  readonly run?: (args: readonly string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;
}


/**
 * Runs one git command with a fixed argument vector.
 *
 * `shell: false` plus an argv array means no metacharacter can become a second
 * command. The directory is passed as `cwd`, never as `-C`, so a model cannot
 * point the command at another repository.
 */
async function runGit(
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  maxBytes: number,
  gitBinary: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // The kernel validates the spawn instead of this module re-deciding what is
    // safe: absolute binary, cwd inside the workspace, an explicit env
    // allowlist, bounded argv, and a bounded timeout. `GIT_TERMINAL_PROMPT=0`
    // is supplied as a caller variable so a hook cannot prompt.
    let spec;
    try {
      spec = validateProcessSpec({
        command: gitBinary,
        args,
        cwd,
        envAllowlist: ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'],
        env: { GIT_TERMINAL_PROMPT: '0' },
        timeoutMs,
      }, cwd, process.env as Record<string, string | undefined>);
    } catch (cause) {
      reject(cause instanceof ProcessSpecError
        ? new ToolRejectedError('git_unavailable')
        : cause);
      return;
    }
    const env: NodeJS.ProcessEnv = { ...spec.env };
    const child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      shell: false,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: { code: number; stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new ToolRejectedError('git_timeout'));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      if (stdout.length < maxBytes) stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < maxBytes) stderr += String(chunk);
    });
    child.once('error', (cause: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new ToolRejectedError(
        cause.code === 'ENOENT' ? 'git_unavailable' : 'git_failed',
      ));
    });
    child.once('close', (code) => finish({ code: code ?? 1, stdout, stderr }));
  });
}

function bounded(text: string, maxBytes: number): string {
  if (text.length <= maxBytes) return text;
  return `${text.slice(0, maxBytes)}\n[truncated at ${maxBytes} bytes]`;
}

/**
 * Builds the git tool provider.
 *
 * The returned provider exposes exactly `git_status`, `git_diff`, and
 * `git_log`. Nothing in this module accepts a subcommand from the caller.
 */
export function createGitReadTools(options: GitToolsOptions): ToolProvider {
  const root = path.resolve(options.root);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_OUTPUT_BYTES;
  // Resolve once: a per-call PATH lookup would let the binary change under a
  // running Runtime, and would make the validated spec differ between calls.
  const gitBinary = options.gitBinary ?? resolveProgram(
    'git',
    options.searchPath ?? process.env.PATH ?? '',
    (candidate) => {
      try {
        accessSync(candidate, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
  );
  const run = options.run ?? ((args, cwd) => runGit(args, cwd, timeoutMs, maxBytes, gitBinary));

  const commit = async (args: ToolArguments): Promise<ToolExecutionResult> => {
    const message = requiredString(args, 'message', 'message');
    if (message.length > 200) throw new ToolRejectedError('invalid_arguments', 'message must be at most 200 characters.');
    // Preview first: show what would be committed, so approval is informed.
    // An empty repository has no HEAD, so `diff --cached` can fail; treat that
    // the same as "nothing staged" rather than a hard error.
    const staged = await invoke(['diff', '--cached', '--name-only']).catch(() => null);
    const files = (staged?.summary ?? '')
      .split('\n')
      .map((line) => line.trim())
      // `invoke` renders empty output as '(no output)'; that is not a file.
      .filter((line) => line.length > 0 && line !== '(no output)' && !line.startsWith('['));
    if (files.length === 0) {
      return Object.freeze({
        ok: false,
        summary: 'nothing staged: stage files (git add) before committing.',
        digest: referenceDigest('git', 'nothing-staged'),
        bytes: 0,
        errorCode: 'nothing_staged',
      });
    }
    const result = await run(['commit', '-m', message], root).catch(() => { throw new ToolRejectedError('git_failed'); });
    if (result.code !== 0) throw new ToolRejectedError('git_failed');
    const summary = bounded(result.stdout, maxBytes).trim();
    return Object.freeze({
      ok: true,
      summary: summary.length > 0 ? summary : `committed ${files.length} file(s)`,
      digest: referenceDigest('git', summary),
      bytes: Buffer.byteLength(summary, 'utf8'),
      evidence: { facts: { message, files: files.join(','), fileCount: files.length } },
    });
  };

  const invoke = async (args: readonly string[]): Promise<ToolExecutionResult> => {
    let result: { code: number; stdout: string; stderr: string };
    try {
      result = await run(args, root);
    } catch (cause) {
      if (cause instanceof ToolRejectedError) throw cause;
      throw new ToolRejectedError('git_failed');
    }
    if (result.code !== 0) {
      // A non-repository directory is a normal answer, not a crash.
      if (/not a git repository/i.test(result.stderr)) {
        throw new ToolRejectedError('not_a_repository');
      }
      throw new ToolRejectedError('git_failed');
    }
    const output = bounded(result.stdout, maxBytes);
    return Object.freeze({
      ok: true,
      summary: output.trim().length > 0 ? output : '(no output)',
      digest: referenceDigest('git', output),
      bytes: Buffer.byteLength(output, 'utf8'),
    });
  };

  return Object.freeze({
    list: () => Object.freeze([
      {
        id: 'git_status',
        version: 1 as const,
        description: 'Show the working tree status (porcelain) for the workspace repository.',
        sideEffect: 'read' as const,
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
      {
        id: 'git_diff',
        version: 1 as const,
        description: 'Show the diff of uncommitted changes, optionally for one tracked path.',
        sideEffect: 'read' as const,
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Optional path relative to the workspace root.' } },
          additionalProperties: false,
        },
      },
      {
        id: 'git_commit',
        version: 1 as const,
        description: 'Commit the currently staged changes with a message. A write: it requires approval.',
        sideEffect: 'write' as const,
        parameters: {
          type: 'object',
          properties: { message: { type: 'string', description: 'Commit message, at most 200 characters.' } },
          required: ['message'],
          additionalProperties: false,
        },
      },
      {
        id: 'git_log',
        version: 1 as const,
        description: 'Show recent commit subjects and authors.',
        sideEffect: 'read' as const,
        parameters: {
          type: 'object',
          properties: { maxCount: { type: 'integer', minimum: 1, maximum: MAX_COMMITS } },
          additionalProperties: false,
        },
      },
    ]),
    has: (toolId: string) => ['git_status', 'git_diff', 'git_log', 'git_commit'].includes(toolId),
    invoke: async (toolId: string, args: ToolArguments) => {
      switch (toolId) {
        case 'git_status':
          return invoke(['status', '--porcelain']);
        case 'git_diff': {
          // A path is passed as a separate argv entry after `--`, so it cannot be
          // reinterpreted as a flag even if it starts with a dash.
          const relative = args.path === undefined ? undefined : requiredString(args, 'path', 'path');
          if (relative !== undefined && (relative.startsWith('/') || relative.includes('..'))) {
            throw new ToolRejectedError('invalid_arguments', 'path must stay inside the workspace.');
          }
          return invoke(relative === undefined ? ['diff'] : ['diff', '--', relative]);
        }
        case 'git_commit':
          return commit(args);
        case 'git_log': {
          const requested = args.maxCount;
          const maxCount = typeof requested === 'number' && Number.isInteger(requested)
            ? Math.min(Math.max(requested, 1), MAX_COMMITS)
            : DEFAULT_MAX_COMMITS;
          return invoke(['log', `-n${maxCount}`, '--pretty=%h %an %s']);
        }
        default:
          throw new ToolRejectedError('unknown_tool');
      }
    },
  });
}
