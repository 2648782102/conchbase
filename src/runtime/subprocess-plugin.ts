import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  readonly startTimeoutMs?: number;
  readonly callTimeoutMs?: number;
  readonly maxResultBytes?: number;
}

export interface SubprocessPluginRequest {
  readonly type: 'invoke';
  readonly toolId: string;
  readonly args: ToolArguments;
}

export interface SubprocessPluginResponse {
  readonly ok: boolean;
  readonly summary?: string;
  readonly errorCode?: string;
}

function digest(prefix: string, value: string): string {
  return `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
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
    const child = spawn(this.options.command, [...this.options.args], {
      shell: false,
      env: boundedEnv(this.options.envAllowlist),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdout.on('data', (chunk) => this.onChunk(String(chunk)));
    child.stderr.on('data', () => {
      // Stderr is deliberately discarded: a plugin must not write raw diagnostics
      // into task events or the model's context.
    });
    // A child that dies mid-call leaves stdin open on our side; writing to it
    // emits 'error', and an unhandled stream error would take the Runtime down
    // instead of failing one tool call.
    child.stdin.on('error', () => this.failAll(new Error('Plugin stdin closed.')));
    child.once('exit', () => this.failAll(new Error('Plugin process exited.')));
    child.once('error', (cause) => this.failAll(cause instanceof Error ? cause : new Error('Plugin process error.')));
    await this.waitReady(child);
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
              digest: digest('plugin', `${toolId}:error`),
              bytes: 0,
              errorCode: typeof response.errorCode === 'string' ? response.errorCode.slice(0, 80) : 'plugin_error',
            }));
            return;
          }
          const summary = String(response.summary ?? '').slice(0, maxResultBytes);
          resolve(Object.freeze({
            ok: true,
            summary: summary.length > 0 ? summary : '(no output)',
            digest: digest('plugin', `${toolId}:${summary}`),
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

  private waitReady(child: ChildProcessWithoutNullStreams): Promise<void> {
    // No discovery or handshake: process spawn success is readiness. The first
    // call will fail with a bounded error if the child cannot speak the protocol.
    // The start timeout only guards a binary that never finishes spawning.
    const startTimeoutMs = this.options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('Plugin did not start in time.'));
      }, startTimeoutMs);
      timer.unref?.();
      child.once('spawn', () => {
        clearTimeout(timer);
        resolve();
      });
      child.once('error', (cause: Error) => {
        clearTimeout(timer);
        reject(cause);
      });
    });
  }

  private onChunk(chunk: string): void {
    // `maxResultBytes` is optional; without the fallback the comparison was
    // `n > undefined * 4` (NaN), which is always false, so a plugin emitting one
    // endless line grew this buffer without bound.
    const cap = (this.options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES) * 4;
    if (this.buffer.length + chunk.length > cap) {
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
