/**
 * Background lifecycle for the local Runtime.
 *
 * Packaging choice (PROJECT_PLAN P6.1): the supported target is the documented
 * local web process. `serve` runs it in the foreground; `start`/`stop`/`logs`
 * manage the same process as a detached child with a pid file and a log file.
 * There is no desktop wrapper and no second service manager.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export interface RuntimeProcessPaths {
  readonly stateDirectory: string;
  readonly pidFile: string;
  readonly logFile: string;
}

/** Pid and log files live beside the database, one set per database. */
export function runtimeProcessPaths(databasePath: string): RuntimeProcessPaths {
  const stateDirectory = path.dirname(path.resolve(databasePath));
  return Object.freeze({
    stateDirectory,
    pidFile: path.join(stateDirectory, 'runtime.pid'),
    logFile: path.join(stateDirectory, 'runtime.log'),
  });
}

export function readPid(pidFile: string): number | null {
  if (!existsSync(pidFile)) return null;
  const raw = readFileSync(pidFile, 'utf8').trim();
  const pid = Number(raw);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** True when the process exists and we may signal it. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as { code?: string })?.code === 'EPERM';
  }
}

export interface StartOptions {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly paths: RuntimeProcessPaths;
}

export interface StartResult {
  readonly pid: number;
  readonly pidFile: string;
  readonly logFile: string;
}

/** Starts a detached Runtime and records its pid. Refuses if one is alive. */
export function startBackground(options: StartOptions): StartResult {
  const existing = readPid(options.paths.pidFile);
  if (existing !== null && isProcessAlive(existing)) {
    throw new Error(`a Runtime is already running (pid ${existing}); stop it first.`);
  }
  mkdirSync(options.paths.stateDirectory, { recursive: true });
  const logFd = openSync(options.paths.logFile, 'a');
  const child = spawn(options.executable, [...options.args], {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();
  closeSync(logFd);
  if (!child.pid) throw new Error('failed to start the Runtime process.');
  // A stale pid file is overwritten with the live child's pid.
  writeFileSync(options.paths.pidFile, `${child.pid}\n`, 'utf8');
  return Object.freeze({ pid: child.pid, pidFile: options.paths.pidFile, logFile: options.paths.logFile });
}

export interface StopResult {
  readonly stopped: boolean;
  readonly pid: number | null;
  readonly detail: string;
}

/** Sends SIGTERM, waits for exit, and clears the pid file. */
export async function stopBackground(options: {
  readonly paths: RuntimeProcessPaths;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
}): Promise<StopResult> {
  const pid = readPid(options.paths.pidFile);
  if (pid === null) return { stopped: false, pid: null, detail: 'no pid file; nothing to stop' };
  if (!isProcessAlive(pid)) {
    unlinkSync(options.paths.pidFile);
    return { stopped: false, pid, detail: 'process was not running; removed the stale pid file' };
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch (cause) {
    return { stopped: false, pid, detail: `could not signal pid ${pid}: ${(cause as Error).message}` };
  }
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  const poll = options.pollMs ?? 100;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      unlinkSync(options.paths.pidFile);
      return { stopped: true, pid, detail: `stopped pid ${pid}` };
    }
    await new Promise((resolve) => setTimeout(resolve, poll));
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // It may have exited between the check and the kill.
  }
  if (existsSync(options.paths.pidFile)) unlinkSync(options.paths.pidFile);
  return { stopped: true, pid, detail: `pid ${pid} did not exit in time; sent SIGKILL` };
}

/** Returns the last `lines` lines of the log, bounded to avoid huge output. */
export function tailLog(logFile: string, lines = 50): string {
  if (!existsSync(logFile)) return '';
  const text = readFileSync(logFile, 'utf8');
  const all = text.split('\n');
  const bounded = all.slice(Math.max(0, all.length - 1 - lines), all.length - 1);
  return bounded.join('\n');
}

/**
 * Child arguments for `start`. A source checkout (*.ts) needs the tsx loader;
 * a built checkout runs dist/cli.js directly. Getting this wrong looks like
 * "started then immediately down", which is hard to diagnose.
 */
export function buildServeArgs(entry: string): string[] {
  const launcher = entry.endsWith('.ts') ? ['--import', 'tsx', entry] : [entry];
  return [...launcher, 'serve'];
}
