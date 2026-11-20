import { referenceDigest } from './digest.js';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { validateProcessSpec } from '../kernel/process-spec.js';
import type { ToolArguments, ToolExecutionResult } from './tool-provider.js';

/**
 * Bounded stdio plugin implementation.
 *
 * This is fault isolation, not a security sandbox: a child process still runs
 * as the same user and inherits filesystem/network access. What it does give us
 * is a fixed protocol, minimal environment, bounded output, timeouts, and a
 * crash boundary around a trusted-but-fallible plugin.
 */

const DEFAULT_START_TIMEOUT_MS = 5_000;
const DEFAULT_CALL_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESULT_BYTES = 32_000;
const REQUIRED_ENV = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'];

export interface SubprocessPluginOptions {
  readonly command: string;
  readonly args: readonly string[];
  /** Only these variable names are passed; values come from the parent. */
  readonly envAllowlist: readonly string[];
  /**
   * Working directory for the plugin process.
   *
   * When present it is validated by the kernel against `workspaceRoot`: a
   * plugin that could choose its own cwd would make the workspace boundary
   * decorative. Absent keeps the historical behaviour of inheriting cwd.
   */
  readonly cwd?: string;
  readonly workspaceRoot?: string;
  readonly startTimeoutMs?: number;
  readonly callTimeoutMs?: number;
  readonly maxResultBytes?: number;
}

export interface SubprocessPluginResponse {
  readonly ok: boolean;
  readonly summary?: string;
  readonly errorCode?: string;
}


function boundedEnv(allowlist: readonly string[]): NodeJS.ProcessEnv {
  const names = new Set([...REQUIRED_ENV, ...allowlist]);
  const env: NodeJS.ProcessEnv = {};
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/** Spawns and owns one plugin child process. */
export class SubprocessPluginClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 0;
  private readonly pending = new Map<number, {
    resolve: (value: SubprocessPluginResponse) => void;
    reject: (cause: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private buffer = '';
  private closed = false;

  constructor(private readonly options: SubprocessPluginOptions) {}

  async start(): Promise<void> {
    if (this.child || this.closed) return;
    // Route the spawn through the kernel when a workspace is known, so the
    // process boundary is the same rule the file tools obey.
    const validated = this.options.cwd && this.options.workspaceRoot
      ? validateProcessSpec({
        command: this.options.command,
        args: this.options.args,
        cwd: this.options.cwd,
        envAllowlist: this.options.envAllowlist,
        ...(this.options.startTimeoutMs ? { timeoutMs: this.options.startTimeoutMs } : {}),
      }, this.options.workspaceRoot, process.env as Record<string, string | undefined>)
      : undefined;
    const child = spawn(validated?.command ?? this.options.command, [...(validated?.args ?? this.options.args)], {
      shell: false,
      env: validated ? { ...validated.env } : boundedEnv(this.options.envAllowlist),
      ...(validated ? { cwd: validated.cwd } : {}),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdout.on('data', (chunk) => this.onChunk(String(chunk)));
    child.stderr.on('data', () => {
      // Stderr is deliberately discarded: a plugin must not write raw diagnostics
      // into task events or the model's context.
    });
    child.once('exit', () => this.failAll(new Error('Plugin process exited.')));
    child.once('error', (cause) => this.failAll(cause instanceof Error ? cause : new Error('Plugin process error.')));
    await this.waitReady();
  }

  invoke(toolId: string, args: ToolArguments): Promise<ToolExecutionResult> {
    const child = this.child;
    if (!child || !child.stdin.writable) throw new Error('Plugin is not running.');
    const callId = this.nextId++;
    const request = `${JSON.stringify({ callId, type: 'invoke', toolId, args })}\n`;
    const callTimeoutMs = this.options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    const maxResultBytes = this.options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(callId);
        reject(new Error('Plugin call timed out.'));
      }, callTimeoutMs);
      this.pending.set(callId, {
        resolve: (response) => {
          if (!response.ok) {
            resolve(Object.freeze({
              ok: false,
              summary: '',
              digest: referenceDigest('plugin', `${toolId}:error`),
              bytes: 0,
              errorCode: typeof response.errorCode === 'string' ? response.errorCode.slice(0, 80) : 'plugin_error',
            }));
            return;
          }
          const summary = String(response.summary ?? '').slice(0, maxResultBytes);
          resolve(Object.freeze({
            ok: true,
            summary: summary.length > 0 ? summary : '(no output)',
            digest: referenceDigest('plugin', `${toolId}:${summary}`),
            bytes: Buffer.byteLength(summary, 'utf8'),
          }));
        },
        reject,
        timer,
      });
      child.stdin.write(request);
    });
  }

  close(): void {
    this.closed = true;
    this.failAll(new Error('Plugin closed.'));
    this.child?.kill('SIGTERM');
    this.child = null;
  }

  private waitReady(): Promise<void> {
    // No discovery or handshake: process spawn success is readiness. The first
    // call will fail with a bounded error if the child cannot speak the protocol.
    return Promise.resolve();
  }

  private onChunk(chunk: string): void {
    if (this.buffer.length + chunk.length > this.options.maxResultBytes! * 4) {
      this.buffer = '';
      this.failAll(new Error('Plugin returned too much output.'));
      return;
    }
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf('\n');
      if (line.length === 0) continue;
      let payload: unknown;
      try {
        payload = JSON.parse(line);
      } catch {
        this.failAll(new Error('Plugin returned invalid JSON.'));
        return;
      }
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        this.failAll(new Error('Plugin returned an invalid response.'));
        return;
      }
      const record = payload as { callId?: unknown; ok?: unknown; summary?: unknown; errorCode?: unknown };
      if (typeof record.callId !== 'number') {
        this.failAll(new Error('Plugin returned a response without a call id.'));
        return;
      }
      const pending = this.pending.get(record.callId);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(record.callId);
      pending.resolve({
        ok: record.ok === true,
        ...(typeof record.summary === 'string' ? { summary: record.summary } : {}),
        ...(typeof record.errorCode === 'string' ? { errorCode: record.errorCode } : {}),
      });
    }
  }

  private failAll(cause: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(cause);
    }
    this.pending.clear();
  }
}
