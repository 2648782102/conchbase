import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const EXECUTION_RUN_CONTRACT_VERSION = '1.3.0';
export const EXECUTION_RUN_PUBLIC_PATHS = Object.freeze([
  '/v1/execution/run-health',
  '/v1/execution/runs',
  '/v1/execution/runs/{runId}',
  '/v1/execution/runs/{runId}/start',
  '/v1/execution/runs/{runId}/cancel',
  '/v1/execution/runs/{runId}/recover',
  '/v1/execution/runs/{runId}/events',
  '/v1/execution/adapters',
] as const);

export type IsolatedOperation = 'hash' | 'echo_length' | 'fixed_matrix';
export type ExecutionRunState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';

export interface ExecutionAdapter {
  readonly version: typeof EXECUTION_RUN_CONTRACT_VERSION;
  readonly id: string;
  readonly kind: 'isolated-local-worker';
  readonly operations: readonly IsolatedOperation[];
  readonly maxInputBytes: number;
  readonly maxRuntimeMs: number;
  readonly network: 'forbidden';
  readonly filesystem: 'no-user-paths';
  readonly createdAt: string;
}

export interface ExecutionRun {
  readonly version: typeof EXECUTION_RUN_CONTRACT_VERSION;
  readonly id: string;
  readonly requestId: string;
  readonly grantId: string;
  readonly operation: IsolatedOperation;
  readonly argumentsDigest: string;
  readonly adapterId: string;
  readonly state: ExecutionRunState;
  readonly attempt: number;
  readonly expectedVersion: number;
  readonly workerPidDigest: string | null;
  readonly exitCode: number | null;
  readonly resultDigest: string | null;
  readonly errorDigest: string | null;
  readonly idempotencyKey: string;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

export type ExecutionRunEventType =
  | 'execution.run_created'
  | 'execution.run_started'
  | 'execution.run_succeeded'
  | 'execution.run_failed'
  | 'execution.run_cancelled'
  | 'execution.run_interrupted'
  | 'execution.run_recovered';

export interface ExecutionRunEvent {
  readonly version: typeof EXECUTION_RUN_CONTRACT_VERSION;
  readonly id: string;
  readonly sequence: number;
  readonly type: ExecutionRunEventType;
  readonly data: Readonly<Record<string, string | number | boolean>>;
  readonly createdAt: string;
}

export interface ExecutionRunSnapshot {
  readonly version: typeof EXECUTION_RUN_CONTRACT_VERSION;
  readonly adapters: readonly ExecutionAdapter[];
  readonly runs: readonly ExecutionRun[];
  readonly events: readonly ExecutionRunEvent[];
}

export class ExecutionRunValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionRunValidationError';
  }
}

export class ExecutionRunConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionRunConflictError';
  }
}

export class ExecutionRunNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionRunNotFoundError';
  }
}

const OPERATIONS: readonly IsolatedOperation[] = Object.freeze(['hash', 'echo_length', 'fixed_matrix']);
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const OPAQUE_PATTERN = /^[a-z][a-z0-9_-]{2,120}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function digest(prefix: string, value: string): string {
  return `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function boundedString(value: unknown, label: string, maximum = 200): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) {
    throw new ExecutionRunValidationError(`${label} must be a non-empty string of at most ${maximum} characters.`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value) || value.includes('/') || value.includes('://')) {
    throw new ExecutionRunValidationError(`${label} contains unsupported characters.`);
  }
  return value;
}

function opaque(value: unknown, label: string): string {
  const candidate = boundedString(value, label);
  if (!OPAQUE_PATTERN.test(candidate)) {
    throw new ExecutionRunValidationError(`${label} must be an opaque reference.`);
  }
  return candidate;
}

function boundedDigest(value: unknown, label: string): string {
  const candidate = boundedString(value, label, 128);
  if (!DIGEST_PATTERN.test(candidate)) {
    throw new ExecutionRunValidationError(`${label} must be a sha256 digest.`);
  }
  return candidate;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new ExecutionRunValidationError(`${label} must be a positive integer.`);
  }
  return value as number;
}

function operation(value: unknown): IsolatedOperation {
  const candidate = boundedString(value, 'operation', 64);
  if (!OPERATIONS.includes(candidate as IsolatedOperation)) {
    throw new ExecutionRunValidationError('operation is not allowlisted.');
  }
  return candidate as IsolatedOperation;
}

function assertKeys(value: Record<string, unknown>, label: string, keys: readonly string[]): void {
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length > 0) {
    throw new ExecutionRunValidationError(`${label} has unknown fields: ${unknown.sort().join(', ')}.`);
  }
  for (const key of keys) {
    if (!(key in value)) throw new ExecutionRunValidationError(`${label} is missing ${key}.`);
  }
}

export interface CreateRunInput {
  readonly requestId: string;
  readonly expectedRequestVersion: number;
  readonly grantId: string;
  readonly operation: IsolatedOperation;
  readonly argumentsDigest: string;
  readonly adapterId: string;
  readonly idempotencyKey: string;
}

export interface RunTransitionInput {
  readonly runId: string;
  readonly expectedVersion: number;
}

export function parseCreateRunInput(input: unknown): CreateRunInput {
  if (!isRecord(input)) throw new ExecutionRunValidationError('Run input must be an object.');
  assertKeys(input, 'Run input', [
    'requestId', 'expectedRequestVersion', 'grantId', 'operation',
    'argumentsDigest', 'adapterId', 'idempotencyKey',
  ]);
  return Object.freeze({
    requestId: opaque(input.requestId, 'requestId'),
    expectedRequestVersion: positiveInteger(input.expectedRequestVersion, 'expectedRequestVersion'),
    grantId: opaque(input.grantId, 'grantId'),
    operation: operation(input.operation),
    argumentsDigest: boundedDigest(input.argumentsDigest, 'argumentsDigest'),
    adapterId: opaque(input.adapterId, 'adapterId'),
    idempotencyKey: boundedString(input.idempotencyKey, 'idempotencyKey', 200),
  });
}

export function parseRunTransitionInput(input: unknown): RunTransitionInput {
  if (!isRecord(input)) throw new ExecutionRunValidationError('Run transition must be an object.');
  assertKeys(input, 'Run transition', ['runId', 'expectedVersion']);
  return Object.freeze({
    runId: opaque(input.runId, 'runId'),
    expectedVersion: positiveInteger(input.expectedVersion, 'expectedVersion'),
  });
}

export interface ApprovedRequestView {
  readonly id: string;
  readonly grantId: string;
  readonly state: string;
  readonly expectedVersion: number;
  readonly operation: string;
  readonly argumentsDigest: string;
}

export interface ActiveGrantView {
  readonly id: string;
  readonly state: string;
  readonly operation: string;
}

export interface IsolatedExecutionHost {
  approvedRequest(requestId: string): ApprovedRequestView | undefined;
  activeGrant(grantId: string): ActiveGrantView | undefined;
}

export interface IsolatedChildResult {
  readonly ok: boolean;
  readonly resultDigest?: string;
  readonly errorDigest?: string;
  readonly outputLength?: number;
  readonly operation?: string;
}

export interface IsolatedChildExecutor {
  execute(input: {
    readonly runId: string;
    readonly requestId: string;
    readonly operation: IsolatedOperation;
    readonly argumentsDigest: string;
  }): Promise<{
    readonly exitCode: number;
    readonly workerPidDigest: string | null;
    readonly result: IsolatedChildResult;
  }>;
}

const workerScript = fileURLToPath(new URL('./isolated-executor-worker.mjs', import.meta.url));

export function createIsolatedChildExecutor(): IsolatedChildExecutor {
  return {
    async execute(input) {
      const payload = JSON.stringify({
        runId: input.runId,
        requestId: input.requestId,
        operation: input.operation,
        argumentsDigest: input.argumentsDigest,
      });
      const child = execFile(
        process.execPath,
        [workerScript, payload],
        {
          timeout: 2000,
          killSignal: 'SIGKILL',
          maxBuffer: 64 * 1024,
          env: {
            PATH: '',
            NODE_OPTIONS: '',
            CONCHBASE_ISOLATED_WORKER: '1',
          },
        },
      );
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
      child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code) => resolve(code ?? -1));
      });
      let result: IsolatedChildResult;
      try {
        result = JSON.parse(stdout.trim()) as IsolatedChildResult;
      } catch {
        result = {
          ok: false,
          errorDigest: sha256(`isolated-worker-invalid-stdout:${stderr.slice(0, 200)}`),
        };
      }
      return Object.freeze({
        exitCode,
        workerPidDigest: child.pid ? sha256(`pid:${child.pid}:${randomUUID()}`) : null,
        result,
      });
    },
  };
}

function createSnapshot(now: () => string): ExecutionRunSnapshot {
  const createdAt = now();
  const adapter: ExecutionAdapter = Object.freeze({
    version: EXECUTION_RUN_CONTRACT_VERSION,
    id: 'adapter_isolated_local_v2',
    kind: 'isolated-local-worker' as const,
    operations: OPERATIONS,
    maxInputBytes: 4096,
    maxRuntimeMs: 2000,
    network: 'forbidden' as const,
    filesystem: 'no-user-paths' as const,
    createdAt,
  });
  return Object.freeze({
    version: EXECUTION_RUN_CONTRACT_VERSION,
    adapters: Object.freeze([adapter]),
    runs: Object.freeze([]),
    events: Object.freeze([]),
  });
}

function appendEvent(
  snapshot: ExecutionRunSnapshot,
  type: ExecutionRunEventType,
  data: Readonly<Record<string, string | number | boolean>>,
  now: () => string,
): readonly ExecutionRunEvent[] {
  const sequence = snapshot.events.length + 1;
  return Object.freeze([
    ...snapshot.events,
    Object.freeze({
      version: EXECUTION_RUN_CONTRACT_VERSION,
      id: digest('xev', `${type}:${sequence}:${JSON.stringify(data)}`),
      sequence,
      type,
      data: Object.freeze({ ...data }),
      createdAt: now(),
    }),
  ]);
}

export class IsolatedExecutionService {
  private snapshot: ExecutionRunSnapshot;
  private readonly now: () => string;
  private readonly executor: IsolatedChildExecutor;
  private readonly host: IsolatedExecutionHost;

  constructor(options: {
    readonly host: IsolatedExecutionHost;
    readonly now?: () => string;
    readonly executor?: IsolatedChildExecutor;
    readonly initialSnapshot?: ExecutionRunSnapshot;
  }) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.executor = options.executor ?? createIsolatedChildExecutor();
    this.host = options.host;
    this.snapshot = options.initialSnapshot ?? createSnapshot(this.now);
    this.interruptRunningRuns();
  }

  get(): ExecutionRunSnapshot {
    return this.snapshot;
  }

  createRun(input: unknown): ExecutionRun {
    const parsed = parseCreateRunInput(input);
    const request = this.host.approvedRequest(parsed.requestId);
    if (!request) throw new ExecutionRunNotFoundError('Approved execution request not found.');
    if (request.state !== 'succeeded') {
      throw new ExecutionRunConflictError('Execution request is not approved and completed.');
    }
    if (request.expectedVersion !== parsed.expectedRequestVersion) {
      throw new ExecutionRunConflictError('Execution request expectedVersion is stale.');
    }
    const grant = this.host.activeGrant(parsed.grantId);
    if (!grant || grant.id !== request.grantId) throw new ExecutionRunNotFoundError('Active grant not found.');
    if (grant.state !== 'granted' || grant.operation !== parsed.operation) {
      throw new ExecutionRunConflictError('Run operation is not authorized by the grant.');
    }
    const adapter = this.snapshot.adapters.find((item) => item.id === parsed.adapterId);
    if (!adapter) throw new ExecutionRunNotFoundError('Execution adapter not found.');
    const id = digest('xrn', JSON.stringify([
      parsed.requestId, parsed.expectedRequestVersion, parsed.grantId, parsed.operation,
      parsed.argumentsDigest, parsed.idempotencyKey,
    ]));
    const existing = this.snapshot.runs.find((item) => item.id === id);
    if (existing) return existing;
    const conflicting = this.snapshot.runs.find((item) => item.idempotencyKey === parsed.idempotencyKey);
    if (conflicting) throw new ExecutionRunConflictError('Execution run idempotency key conflicts.');
    const run: ExecutionRun = Object.freeze({
      version: EXECUTION_RUN_CONTRACT_VERSION,
      id,
      requestId: parsed.requestId,
      grantId: parsed.grantId,
      operation: parsed.operation,
      argumentsDigest: parsed.argumentsDigest,
      adapterId: parsed.adapterId,
      state: 'queued' as const,
      attempt: 1,
      expectedVersion: 1,
      workerPidDigest: null,
      exitCode: null,
      resultDigest: null,
      errorDigest: null,
      idempotencyKey: parsed.idempotencyKey,
      createdAt: this.now(),
      startedAt: null,
      finishedAt: null,
    });
    this.snapshot = Object.freeze({
      ...this.snapshot,
      runs: Object.freeze([...this.snapshot.runs, run]),
      events: appendEvent(this.snapshot, 'execution.run_created', {
        runId: run.id,
        requestId: run.requestId,
        grantId: run.grantId,
        operation: run.operation,
        argumentsDigest: run.argumentsDigest,
      }, this.now),
    });
    return run;
  }

  async startRun(input: unknown): Promise<ExecutionRun> {
    const parsed = parseRunTransitionInput(input);
    const run = this.getRun(parsed.runId);
    if (run.state !== 'queued') throw new ExecutionRunConflictError('Run is not queued.');
    this.assertVersion(run, parsed.expectedVersion);
    const running: ExecutionRun = Object.freeze({
      ...run,
      state: 'running' as const,
      expectedVersion: run.expectedVersion + 1,
      startedAt: this.now(),
    });
    this.replaceRun(running);
    this.snapshot = Object.freeze({
      ...this.snapshot,
      events: appendEvent(this.snapshot, 'execution.run_started', {
        runId: run.id,
        attempt: run.attempt,
        adapterId: run.adapterId,
      }, this.now),
    });
    const execution = await this.executor.execute({
      runId: running.id,
      requestId: running.requestId,
      operation: running.operation,
      argumentsDigest: running.argumentsDigest,
    });
    const succeeded = execution.exitCode === 0 && execution.result.ok
      && typeof execution.result.resultDigest === 'string';
    const finished: ExecutionRun = Object.freeze({
      ...running,
      state: succeeded ? 'succeeded' as const : 'failed' as const,
      expectedVersion: running.expectedVersion + 1,
      workerPidDigest: execution.workerPidDigest,
      exitCode: execution.exitCode,
      resultDigest: succeeded ? execution.result.resultDigest! : null,
      errorDigest: succeeded ? null : execution.result.errorDigest ?? sha256(`isolated-worker-exit:${execution.exitCode}`),
      finishedAt: this.now(),
    });
    this.replaceRun(finished);
    this.snapshot = Object.freeze({
      ...this.snapshot,
      events: appendEvent(this.snapshot,
        succeeded ? 'execution.run_succeeded' : 'execution.run_failed', {
          runId: run.id,
          attempt: run.attempt,
          exitCode: execution.exitCode,
          resultDigest: finished.resultDigest ?? '',
          errorDigest: finished.errorDigest ?? '',
        }, this.now),
    });
    return finished;
  }

  cancelRun(input: unknown): ExecutionRun {
    const parsed = parseRunTransitionInput(input);
    const run = this.getRun(parsed.runId);
    if (run.state !== 'queued') throw new ExecutionRunConflictError('Only queued runs can be cancelled.');
    this.assertVersion(run, parsed.expectedVersion);
    const cancelled: ExecutionRun = Object.freeze({
      ...run,
      state: 'cancelled' as const,
      expectedVersion: run.expectedVersion + 1,
      finishedAt: this.now(),
    });
    this.replaceRun(cancelled);
    this.snapshot = Object.freeze({
      ...this.snapshot,
      events: appendEvent(this.snapshot, 'execution.run_cancelled', {
        runId: run.id,
        attempt: run.attempt,
      }, this.now),
    });
    return cancelled;
  }

  recoverRun(input: unknown): ExecutionRun {
    const parsed = parseRunTransitionInput(input);
    const run = this.getRun(parsed.runId);
    if (run.state !== 'interrupted' && run.state !== 'failed') {
      throw new ExecutionRunConflictError('Only interrupted or failed runs can recover.');
    }
    this.assertVersion(run, parsed.expectedVersion);
    const recovered: ExecutionRun = Object.freeze({
      ...run,
      state: 'queued' as const,
      attempt: run.attempt + 1,
      expectedVersion: run.expectedVersion + 1,
      workerPidDigest: null,
      exitCode: null,
      resultDigest: null,
      errorDigest: null,
      startedAt: null,
      finishedAt: null,
    });
    this.replaceRun(recovered);
    this.snapshot = Object.freeze({
      ...this.snapshot,
      events: appendEvent(this.snapshot, 'execution.run_recovered', {
        runId: run.id,
        attempt: recovered.attempt,
      }, this.now),
    });
    return recovered;
  }

  getRun(runId: string): ExecutionRun {
    const run = this.snapshot.runs.find((item) => item.id === runId);
    if (!run) throw new ExecutionRunNotFoundError('Execution run not found.');
    return run;
  }

  runEvents(after?: string, limit = 100): readonly ExecutionRunEvent[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new ExecutionRunValidationError('limit must be an integer from 1 to 1000.');
    }
    const cursorIndex = after === undefined ? -1 : this.snapshot.events.findIndex((event) => event.id === after);
    if (after !== undefined && cursorIndex < 0) {
      throw new ExecutionRunValidationError('Unknown execution run event cursor.');
    }
    return Object.freeze(this.snapshot.events.slice(cursorIndex + 1, cursorIndex + 1 + limit));
  }

  private interruptRunningRuns(): void {
    let interruptedCount = 0;
    const interrupted = this.snapshot.runs.map((run) => {
      if (run.state !== 'running') return run;
      interruptedCount += 1;
      return Object.freeze({
        ...run,
        state: 'interrupted' as const,
        expectedVersion: run.expectedVersion + 1,
        finishedAt: this.now(),
      });
    });
    this.snapshot = Object.freeze({
      ...this.snapshot,
      runs: Object.freeze(interrupted),
      events: interruptedCount === 0
        ? this.snapshot.events
        : appendEvent(this.snapshot, 'execution.run_interrupted', {
          runId: 'runtime',
          recoveredCount: interruptedCount,
        }, this.now),
    });
  }

  private assertVersion(run: ExecutionRun, expectedVersion: number): void {
    if (run.expectedVersion !== expectedVersion) {
      throw new ExecutionRunConflictError('Execution run expectedVersion is stale.');
    }
  }

  private replaceRun(run: ExecutionRun): void {
    this.snapshot = Object.freeze({
      ...this.snapshot,
      runs: this.snapshot.runs.map((item) => item.id === run.id ? run : item),
    });
  }
}
