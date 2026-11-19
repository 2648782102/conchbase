/**
 * `conchbase diagnose`: one readable pass over the things that usually break a
 * local install. Each check is independent and injectable so it can be tested
 * without a real network, port, or filesystem.
 */
import { accessSync, constants, existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import path from 'node:path';
import { checkNodeVersion } from './node-version.js';

export type DiagnosticStatus = 'ok' | 'warn' | 'fail';

export interface DiagnosticCheck {
  readonly id: string;
  readonly status: DiagnosticStatus;
  readonly detail: string;
}

export interface DiagnosticContext {
  readonly nodeVersion: string;
  readonly databasePath: string;
  readonly workspaceRoot: string;
  readonly port: number;
  readonly host: string;
  readonly magpieBaseUrl: string;
  readonly consolePort: number;
  /** 'free' | 'busy' */
  readonly checkPort: (host: string, port: number) => Promise<'free' | 'busy'>;
  /** 'reachable' | 'unreachable' */
  readonly checkHttp: (url: string) => Promise<'reachable' | 'unreachable'>;
  /** Number of models the gateway advertises, or null when unavailable. */
  readonly modelCount: () => Promise<number | null>;
}

function probePort(host: string, port: number): Promise<'free' | 'busy'> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (result: 'free' | 'busy') => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.once('connect', () => finish('busy'));
    socket.once('error', () => finish('free'));
    socket.setTimeout(500, () => finish('free'));
  });
}

async function probeHttp(url: string): Promise<'reachable' | 'unreachable'> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return response.ok ? 'reachable' : 'unreachable';
  } catch {
    return 'unreachable';
  }
}

function checkDatabase(file: string): DiagnosticCheck {
  // An existing, non-empty file is fine to report on; the lock itself is only
  // observable by trying to open it, which diagnose deliberately does not do.

  const directory = path.dirname(file);
  try {
    mkdirSync(directory, { recursive: true });
    const probe = path.join(directory, `.diagnose-${process.pid}`);
    writeFileSync(probe, 'ok');
    unlinkSync(probe);
    if (existsSync(file) && statSync(file).isDirectory()) {
      return { id: 'database', status: 'fail', detail: `${file} is a directory, not a database file.` };
    }
    return { id: 'database', status: 'ok', detail: `${file} is writable.` };
  } catch (cause) {
    return {
      id: 'database',
      status: 'fail',
      detail: `cannot write database directory ${directory}: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
}

function checkWorkspace(root: string): DiagnosticCheck {
  try {
    if (!existsSync(root)) {
      return { id: 'workspace', status: 'fail', detail: `${root} does not exist. Create it or set CONCHBASE_WORKSPACE_ROOT.` };
    }
    accessSync(root, constants.R_OK);
    return { id: 'workspace', status: 'ok', detail: `${root} is readable.` };
  } catch (cause) {
    return {
      id: 'workspace',
      status: 'fail',
      detail: `cannot read ${root}: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
}

export async function buildDiagnosticChecks(context: DiagnosticContext): Promise<readonly DiagnosticCheck[]> {
  const checks: DiagnosticCheck[] = [];

  const node = checkNodeVersion(context.nodeVersion);
  checks.push({ id: 'node', status: node.ok ? 'ok' : 'fail', detail: node.message });

  checks.push(checkDatabase(context.databasePath));
  checks.push(checkWorkspace(context.workspaceRoot));

  const port = await context.checkPort(context.host, context.port);
  checks.push({
    id: 'runtime-port',
    status: port === 'free' ? 'ok' : 'warn',
    detail: port === 'free'
      ? `${context.host}:${context.port} is free.`
      : `${context.host}:${context.port} is already in use (another Runtime or process).`,
  });

  const startedAt = Date.now();
  const gateway = await context.checkHttp(`${context.magpieBaseUrl.replace(/\/$/, '')}/v1/models`);
  const latency = Date.now() - startedAt;
  const modelCount = await context.modelCount();
  checks.push({
    id: 'gateway',
    status: gateway === 'reachable' ? 'ok' : 'warn',
    detail: gateway === 'reachable'
      ? `${context.magpieBaseUrl} answered in ${latency}ms; ${modelCount ?? 0} model(s) available.`
      : `${context.magpieBaseUrl} is unreachable after ${latency}ms; real model calls will fail (tests do not need it).`,
  });

  const consoleUrl = `http://127.0.0.1:${context.consolePort}/`;
  const consoleState = await context.checkHttp(consoleUrl);
  checks.push({
    id: 'console',
    status: consoleState === 'reachable' ? 'ok' : 'warn',
    detail: consoleState === 'reachable'
      ? `Pagurus console answered on ${consoleUrl}.`
      : `no console on ${consoleUrl}; start it with "cd pagurus && npm run dev".`,
  });

  return Object.freeze(checks);
}

export function formatDiagnostics(checks: readonly DiagnosticCheck[]): string {
  const labels: Record<DiagnosticStatus, string> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' };
  const lines = checks.map((check) => `${labels[check.status]}  ${check.id.padEnd(12)} ${check.detail}`);
  const failed = checks.filter((check) => check.status === 'fail').length;
  const warned = checks.filter((check) => check.status === 'warn').length;
  lines.push('');
  lines.push(failed > 0
    ? `${failed} check(s) failed, ${warned} warning(s). Fix the failures before starting the Runtime.`
    : warned > 0
      ? `All required checks passed with ${warned} warning(s).`
      : 'All checks passed.');
  return `${lines.join('\n')}\n`;
}

export function defaultDiagnosticContext(config: {
  nodeVersion?: string;
  databasePath: string;
  workspaceRoot: string;
  port: number;
  host: string;
  magpieBaseUrl: string;
  consolePort?: number;
}): DiagnosticContext {
  return {
    nodeVersion: config.nodeVersion ?? process.versions.node,
    databasePath: config.databasePath,
    workspaceRoot: config.workspaceRoot,
    port: config.port,
    host: config.host,
    magpieBaseUrl: config.magpieBaseUrl,
    consolePort: config.consolePort ?? (config.port === 4318 ? 5173 : 5173 + (config.port - 4318)),
    checkPort: probePort,
    checkHttp: probeHttp,
    modelCount: async () => {
      try {
        const response = await fetch(`${config.magpieBaseUrl.replace(/\/$/, '')}/v1/models`, { signal: AbortSignal.timeout(2_000) });
        if (!response.ok) return null;
        const payload = await response.json() as { data?: unknown };
        return Array.isArray(payload.data) ? payload.data.length : null;
      } catch {
        return null;
      }
    },
  };
}

/** Runs the checks, prints a report, and returns a process exit code. */
export async function runDiagnostics(config: {
  databasePath: string;
  workspaceRoot: string;
  port: number;
  host: string;
  magpieBaseUrl: string;
}): Promise<number> {
  const checks = await buildDiagnosticChecks(defaultDiagnosticContext(config));
  process.stdout.write(formatDiagnostics(checks));
  return checks.some((check) => check.status === 'fail') ? 1 : 0;
}
