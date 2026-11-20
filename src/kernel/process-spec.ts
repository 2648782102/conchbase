/**
 * The one place that says what a spawned process may be.
 *
 * Four modules spawn children today — plugin subprocess, git tools, isolated
 * execution, and the Runtime's own supervisor — and each carries its own
 * version of "allowlisted env, bounded output, timeout, orderly kill". That is
 * four chances to forget one rule, exactly like the four approval sites.
 *
 * This module does not spawn anything. It validates a *spec* and produces the
 * runtime parameters, so execution stays in the module that owns it while the
 * safety rules live in one testable place.
 */

export interface ProcessSpec {
  /** Absolute executable path. A bare name would be resolved via PATH. */
  readonly command: string;
  readonly args: readonly string[];
  /** Working directory; must be an absolute path inside the workspace. */
  readonly cwd: string;
  /** Environment allowlist: only these names may be inherited. */
  readonly envAllowlist: readonly string[];
  /** Extra variables supplied by the caller; values are opaque. */
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

export interface ValidatedProcessSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  /** Always true: every spawned process must be killable on shutdown. */
  readonly killable: true;
}

/**
 * Resolves a bare program name to an absolute path using an explicit PATH.
 *
 * Some tools (`git`) are conventionally invoked by name, and hard-coding
 * `/usr/bin/git` would break on every machine that installs it elsewhere. The
 * resolution is deliberately explicit and one-shot: the caller passes the PATH
 * it trusts, gets back an absolute path, and the spec validator still refuses
 * anything relative. Nothing here silently searches the ambient environment.
 */
export function resolveProgram(
  program: string,
  pathValue: string,
  isExecutable: (candidate: string) => boolean,
): string {
  if (isAbsolute(program)) return program;
  if (program.includes('/') || program.includes('\\')) {
    throw new ProcessSpecError(`program '${program}' must be absolute or a bare name.`);
  }
  for (const directory of pathValue.split(':').filter((entry) => entry.length > 0)) {
    if (!isAbsolute(directory)) continue;
    const candidate = `${directory.replace(/\/+$/, '')}/${program}`;
    if (isExecutable(candidate)) return candidate;
  }
  throw new ProcessSpecError(`program '${program}' was not found on the provided PATH.`);
}

export class ProcessSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProcessSpecError';
  }
}

export const PROCESS_LIMITS = Object.freeze({
  maxArgs: 32,
  maxArgLength: 4096,
  maxEnvEntries: 16,
  defaultTimeoutMs: 5_000,
  maxTimeoutMs: 120_000,
});

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function isAbsolute(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);
}

/**
 * Validates a spec and fills in limits.
 *
 * `workspaceRoot` is required because a process's working directory is a
 * boundary: letting it point anywhere would make the workspace rule decorative.
 * The caller must already have resolved real paths; this check is lexical and
 * intentionally strict rather than clever.
 */
export function validateProcessSpec(
  spec: ProcessSpec,
  workspaceRoot: string,
  sourceEnv: Readonly<Record<string, string | undefined>> = {},
): ValidatedProcessSpec {
  if (!isAbsolute(spec.command)) {
    throw new ProcessSpecError('process command must be an absolute path.');
  }
  if (spec.command.includes('\0')) {
    throw new ProcessSpecError('process command must not contain NUL.');
  }
  if (!isAbsolute(workspaceRoot) || !isAbsolute(spec.cwd)) {
    throw new ProcessSpecError('process cwd and workspace root must be absolute.');
  }
  const root = workspaceRoot.replace(/[\\/]+$/, '');
  const cwd = spec.cwd.replace(/[\\/]+$/, '');
  if (cwd !== root && !cwd.startsWith(`${root}/`) && !cwd.startsWith(`${root}\\`)) {
    throw new ProcessSpecError('process cwd must stay inside the workspace root.');
  }
  if (spec.args.length > PROCESS_LIMITS.maxArgs) {
    throw new ProcessSpecError(`process may take at most ${PROCESS_LIMITS.maxArgs} arguments.`);
  }
  for (const arg of spec.args) {
    if (typeof arg !== 'string' || arg.includes('\0') || arg.length > PROCESS_LIMITS.maxArgLength) {
      throw new ProcessSpecError('process arguments must be bounded strings without NUL.');
    }
  }

  const env: Record<string, string> = {};
  for (const name of spec.envAllowlist) {
    if (!ENV_NAME.test(name)) {
      throw new ProcessSpecError(`environment name '${name}' is not valid.`);
    }
    const value = sourceEnv[name];
    if (value !== undefined) env[name] = value;
  }
  const extra = spec.env ?? {};
  if (Object.keys(extra).length > PROCESS_LIMITS.maxEnvEntries) {
    throw new ProcessSpecError(`process may receive at most ${PROCESS_LIMITS.maxEnvEntries} extra variables.`);
  }
  for (const [name, value] of Object.entries(extra)) {
    if (!ENV_NAME.test(name)) {
      throw new ProcessSpecError(`environment name '${name}' is not valid.`);
    }
    if (typeof value !== 'string' || value.includes('\0')) {
      throw new ProcessSpecError(`environment value for '${name}' must be a bounded string.`);
    }
    env[name] = value;
  }

  const requested = spec.timeoutMs ?? PROCESS_LIMITS.defaultTimeoutMs;
  if (!Number.isInteger(requested) || requested < 1 || requested > PROCESS_LIMITS.maxTimeoutMs) {
    throw new ProcessSpecError(
      `process timeout must be an integer between 1 and ${PROCESS_LIMITS.maxTimeoutMs} ms.`,
    );
  }

  return Object.freeze({
    command: spec.command,
    args: Object.freeze([...spec.args]),
    cwd: spec.cwd,
    env: Object.freeze(env),
    timeoutMs: requested,
    killable: true,
  });
}
