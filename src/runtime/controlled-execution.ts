import { createHash } from 'node:crypto';

export const EXECUTION_CONTRACT_VERSION = '1.2.0';
export const EXECUTION_PUBLIC_PATHS = Object.freeze([
  '/v1/execution/health',
  '/v1/execution/capabilities',
  '/v1/execution/grants',
  '/v1/execution/grants/{grantId}/revoke',
  '/v1/execution/requests',
  '/v1/execution/requests/{requestId}',
  '/v1/execution/requests/{requestId}/decide',
  '/v1/execution/events',
] as const);

export type CapabilityKind = 'mcp' | 'skill' | 'plugin' | 'secret-handle' | 'fake';
export type CapabilityState = 'recorded' | 'enabled' | 'revoked';
export type GrantState = 'granted' | 'revoked';
export type ExecutionRequestState =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'running'
  | 'succeeded'
  | 'failed';
export type ExecutionDecision = 'approved' | 'rejected';

export interface ExecutionCapability {
  readonly version: typeof EXECUTION_CONTRACT_VERSION;
  readonly id: string;
  readonly kind: CapabilityKind;
  readonly name: string;
  readonly adapterId: string;
  readonly destinationDigest: string;
  readonly capabilitiesDigest: string;
  readonly state: CapabilityState;
  readonly createdAt: string;
}

export interface ExecutionGrant {
  readonly version: typeof EXECUTION_CONTRACT_VERSION;
  readonly id: string;
  readonly capabilityId: string;
  readonly state: GrantState;
  readonly expectedVersion: number;
  readonly agentId: string;
  readonly agentRevisionId: string;
  readonly configurationRevisionId: string;
  readonly delegationId: string;
  readonly projectId: string;
  readonly workItemId: string;
  readonly assignmentId: string;
  readonly operation: string;
  readonly destinationDigest: string;
  readonly scope: readonly string[];
  readonly capabilities: readonly string[];
  readonly expiresAtSequence: number;
  readonly createdAt: string;
  readonly revokedAt: string | null;
}

export interface ExecutionRequest {
  readonly version: typeof EXECUTION_CONTRACT_VERSION;
  readonly id: string;
  readonly grantId: string;
  readonly state: ExecutionRequestState;
  readonly expectedVersion: number;
  readonly operation: string;
  readonly argumentsDigest: string;
  readonly idempotencyKey: string;
  readonly resultDigest: string | null;
  readonly errorDigest: string | null;
  readonly createdAt: string;
  readonly decidedAt: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

export type ExecutionEventType =
  | 'execution.capability_recorded'
  | 'execution.capability_enabled'
  | 'execution.capability_revoked'
  | 'execution.grant_created'
  | 'execution.grant_revoked'
  | 'execution.request_created'
  | 'execution.request_approved'
  | 'execution.request_rejected'
  | 'execution.started'
  | 'execution.succeeded'
  | 'execution.failed';

export interface ExecutionEvent {
  readonly version: typeof EXECUTION_CONTRACT_VERSION;
  readonly id: string;
  readonly sequence: number;
  readonly type: ExecutionEventType;
  readonly data: Readonly<Record<string, string | number | boolean>>;
  readonly createdAt: string;
}

export interface ExecutionSnapshot {
  readonly version: typeof EXECUTION_CONTRACT_VERSION;
  readonly capabilities: readonly ExecutionCapability[];
  readonly grants: readonly ExecutionGrant[];
  readonly requests: readonly ExecutionRequest[];
  readonly events: readonly ExecutionEvent[];
}

export class ExecutionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionValidationError';
  }
}

export class ExecutionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionConflictError';
  }
}

export class ExecutionNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionNotFoundError';
  }
}

const CAPABILITY_KINDS: readonly CapabilityKind[] = Object.freeze(['mcp', 'skill', 'plugin', 'secret-handle', 'fake']);
const OPAQUE_PATTERN = /^[a-z][a-z0-9_-]{2,120}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const OPERATION_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

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
    throw new ExecutionValidationError(`${label} must be a non-empty string of at most ${maximum} characters.`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value) || value.includes('/') || value.includes('://')) {
    throw new ExecutionValidationError(`${label} contains unsupported characters.`);
  }
  return value;
}

function opaque(value: unknown, label: string): string {
  const candidate = boundedString(value, label);
  if (!OPAQUE_PATTERN.test(candidate)) {
    throw new ExecutionValidationError(`${label} must be an opaque reference.`);
  }
  return candidate;
}

function boundedDigest(value: unknown, label: string): string {
  const candidate = boundedString(value, label, 128);
  if (!DIGEST_PATTERN.test(candidate)) {
    throw new ExecutionValidationError(`${label} must be a sha256 digest.`);
  }
  return candidate;
}

function exactVersion(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new ExecutionValidationError(`${label} must be a positive integer.`);
  }
  return value as number;
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    throw new ExecutionValidationError(`${label} must contain 1 to 16 entries.`);
  }
  const entries = value.map((entry) => boundedString(entry, label, 120));
  if (new Set(entries).size !== entries.length) {
    throw new ExecutionValidationError(`${label} must not contain duplicates.`);
  }
  return Object.freeze(entries);
}

function assertKeys(value: Record<string, unknown>, label: string, keys: readonly string[]): void {
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length > 0) {
    throw new ExecutionValidationError(`${label} has unknown fields: ${unknown.sort().join(', ')}.`);
  }
  for (const key of keys) {
    if (!(key in value)) throw new ExecutionValidationError(`${label} is missing ${key}.`);
  }
}

export interface CreateGrantInput {
  readonly capabilityId: string;
  readonly agentId: string;
  readonly agentRevisionId: string;
  readonly configurationRevisionId: string;
  readonly delegationId: string;
  readonly projectId: string;
  readonly workItemId: string;
  readonly assignmentId: string;
  readonly operation: string;
  readonly destinationDigest: string;
  readonly scope: readonly string[];
  readonly capabilities: readonly string[];
  readonly expiresAtSequence: number;
}

export interface CreateRequestInput {
  readonly grantId: string;
  readonly expectedGrantVersion: number;
  readonly operation: string;
  readonly argumentsDigest: string;
  readonly idempotencyKey: string;
}

export interface DecideRequestInput {
  readonly requestId: string;
  readonly expectedVersion: number;
  readonly decision: ExecutionDecision;
  readonly reasonDigest: string;
}

export function parseCreateGrantInput(input: unknown): CreateGrantInput {
  if (!isRecord(input)) throw new ExecutionValidationError('Grant input must be an object.');
  assertKeys(input, 'Grant input', [
    'capabilityId', 'agentId', 'agentRevisionId', 'configurationRevisionId',
    'delegationId', 'projectId', 'workItemId', 'assignmentId', 'operation',
    'destinationDigest', 'scope', 'capabilities', 'expiresAtSequence',
  ]);
  const operation = boundedString(input.operation, 'operation', 64);
  if (!OPERATION_PATTERN.test(operation)) {
    throw new ExecutionValidationError('operation must be a bounded opaque operation.');
  }
  if (!Number.isInteger(input.expiresAtSequence) || (input.expiresAtSequence as number) < 1) {
    throw new ExecutionValidationError('expiresAtSequence must be a positive integer.');
  }
  return Object.freeze({
    capabilityId: opaque(input.capabilityId, 'capabilityId'),
    agentId: opaque(input.agentId, 'agentId'),
    agentRevisionId: opaque(input.agentRevisionId, 'agentRevisionId'),
    configurationRevisionId: opaque(input.configurationRevisionId, 'configurationRevisionId'),
    delegationId: opaque(input.delegationId, 'delegationId'),
    projectId: opaque(input.projectId, 'projectId'),
    workItemId: opaque(input.workItemId, 'workItemId'),
    assignmentId: opaque(input.assignmentId, 'assignmentId'),
    operation,
    destinationDigest: boundedDigest(input.destinationDigest, 'destinationDigest'),
    scope: stringArray(input.scope, 'scope'),
    capabilities: stringArray(input.capabilities, 'capabilities'),
    expiresAtSequence: input.expiresAtSequence as number,
  });
}

export function parseCreateRequestInput(input: unknown): CreateRequestInput {
  if (!isRecord(input)) throw new ExecutionValidationError('Request input must be an object.');
  assertKeys(input, 'Request input', [
    'grantId', 'expectedGrantVersion', 'operation', 'argumentsDigest', 'idempotencyKey',
  ]);
  const operation = boundedString(input.operation, 'operation', 64);
  if (!OPERATION_PATTERN.test(operation)) {
    throw new ExecutionValidationError('operation must be a bounded opaque operation.');
  }
  return Object.freeze({
    grantId: opaque(input.grantId, 'grantId'),
    expectedGrantVersion: exactVersion(input.expectedGrantVersion, 'expectedGrantVersion'),
    operation,
    argumentsDigest: boundedDigest(input.argumentsDigest, 'argumentsDigest'),
    idempotencyKey: boundedString(input.idempotencyKey, 'idempotencyKey', 200),
  });
}

export function parseDecideRequestInput(input: unknown): DecideRequestInput {
  if (!isRecord(input)) throw new ExecutionValidationError('Decision input must be an object.');
  assertKeys(input, 'Decision input', ['requestId', 'expectedVersion', 'decision', 'reasonDigest']);
  const decision = input.decision;
  if (decision !== 'approved' && decision !== 'rejected') {
    throw new ExecutionValidationError('decision must be approved or rejected.');
  }
  return Object.freeze({
    requestId: opaque(input.requestId, 'requestId'),
    expectedVersion: exactVersion(input.expectedVersion, 'expectedVersion'),
    decision,
    reasonDigest: boundedDigest(input.reasonDigest, 'reasonDigest'),
  });
}

export interface FakeExecutionResult {
  readonly outcome: 'succeeded' | 'failed';
  readonly resultDigest: string | null;
  readonly errorDigest: string | null;
}

export interface FakeExecutor {
  execute(request: ExecutionRequest): Promise<FakeExecutionResult>;
}

export function createDeterministicFakeExecutor(): FakeExecutor {
  return {
    async execute(request) {
      const resultDigest = sha256(`fake-execution:${request.id}:${request.argumentsDigest}`);
      return Object.freeze({
        outcome: 'succeeded' as const,
        resultDigest,
        errorDigest: null,
      });
    },
  };
}

export function createExecutionSnapshot(now = () => new Date().toISOString()): ExecutionSnapshot {
  const createdAt = now();
  const capabilities = Object.freeze([
    Object.freeze({
      version: EXECUTION_CONTRACT_VERSION,
      id: 'cap_fake_observe',
      kind: 'fake' as const,
      name: 'fake-observe',
      adapterId: 'fake-bounded-executor',
      destinationDigest: sha256('fake:observe'),
      capabilitiesDigest: sha256('capability:fake-observe'),
      state: 'enabled' as const,
      createdAt,
    }),
  ]);
  return Object.freeze({
    version: EXECUTION_CONTRACT_VERSION,
    capabilities,
    grants: Object.freeze([]),
    requests: Object.freeze([]),
    events: Object.freeze([
      Object.freeze({
        version: EXECUTION_CONTRACT_VERSION,
        id: digest('exe', 'execution.capability_enabled:cap_fake_observe'),
        sequence: 1,
        type: 'execution.capability_enabled' as const,
        data: Object.freeze({ capabilityId: 'cap_fake_observe', state: 'enabled' }),
        createdAt,
      }),
    ]),
  });
}

function appendEvent(
  snapshot: ExecutionSnapshot,
  type: ExecutionEventType,
  data: Readonly<Record<string, string | number | boolean>>,
  now: () => string,
): readonly ExecutionEvent[] {
  const sequence = snapshot.events.length + 1;
  return Object.freeze([
    ...snapshot.events,
    Object.freeze({
      version: EXECUTION_CONTRACT_VERSION,
      id: digest('exe', `${type}:${sequence}:${JSON.stringify(data)}`),
      sequence,
      type,
      data: Object.freeze({ ...data }),
      createdAt: now(),
    }),
  ]);
}

export class ControlledExecutionService {
  private snapshot: ExecutionSnapshot;
  private readonly now: () => string;
  private readonly executor: FakeExecutor;

  constructor(options: { readonly now?: () => string; readonly executor?: FakeExecutor } = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.executor = options.executor ?? createDeterministicFakeExecutor();
    this.snapshot = createExecutionSnapshot(this.now);
  }

  get(): ExecutionSnapshot {
    return this.snapshot;
  }

  approvedRequest(requestId: string): {
    readonly id: string;
    readonly grantId: string;
    readonly state: ExecutionRequestState;
    readonly expectedVersion: number;
    readonly operation: string;
    readonly argumentsDigest: string;
  } | undefined {
    const request = this.snapshot.requests.find((item) => item.id === requestId);
    if (!request) return undefined;
    return Object.freeze({
      id: request.id,
      grantId: request.grantId,
      state: request.state,
      expectedVersion: request.expectedVersion,
      operation: request.operation,
      argumentsDigest: request.argumentsDigest,
    });
  }

  activeGrant(grantId: string): {
    readonly id: string;
    readonly state: GrantState;
    readonly operation: string;
  } | undefined {
    const grant = this.snapshot.grants.find((item) => item.id === grantId);
    if (!grant) return undefined;
    return Object.freeze({
      id: grant.id,
      state: grant.state,
      operation: grant.operation,
    });
  }

  createGrant(input: unknown): ExecutionGrant {
    const parsed = parseCreateGrantInput(input);
    const capability = this.snapshot.capabilities.find((item) => item.id === parsed.capabilityId);
    if (!capability) throw new ExecutionNotFoundError('Capability not found.');
    if (capability.state !== 'enabled') throw new ExecutionConflictError('Capability is not enabled.');
    if (capability.destinationDigest !== parsed.destinationDigest) {
      throw new ExecutionConflictError('Grant destination does not match capability.');
    }
    if (!parsed.capabilities.every((item) => capability.kind === item || item.startsWith('cap_'))) {
      throw new ExecutionValidationError('Grant capabilities are not accepted.');
    }
    const id = digest('xgt', JSON.stringify([
      parsed.capabilityId, parsed.agentId, parsed.agentRevisionId, parsed.delegationId,
      parsed.workItemId, parsed.assignmentId, parsed.operation, parsed.scope, parsed.capabilities,
    ]));
    const existing = this.snapshot.grants.find((item) => item.id === id);
    if (existing) return existing;
    const grant = Object.freeze({
      version: EXECUTION_CONTRACT_VERSION,
      id,
      capabilityId: parsed.capabilityId,
      state: 'granted' as const,
      expectedVersion: 1,
      agentId: parsed.agentId,
      agentRevisionId: parsed.agentRevisionId,
      configurationRevisionId: parsed.configurationRevisionId,
      delegationId: parsed.delegationId,
      projectId: parsed.projectId,
      workItemId: parsed.workItemId,
      assignmentId: parsed.assignmentId,
      operation: parsed.operation,
      destinationDigest: parsed.destinationDigest,
      scope: parsed.scope,
      capabilities: parsed.capabilities,
      expiresAtSequence: parsed.expiresAtSequence,
      createdAt: this.now(),
      revokedAt: null,
    });
    this.snapshot = Object.freeze({
      ...this.snapshot,
      grants: Object.freeze([...this.snapshot.grants, grant]),
      events: appendEvent(this.snapshot, 'execution.grant_created', {
        grantId: grant.id,
        capabilityId: grant.capabilityId,
        agentRevisionId: grant.agentRevisionId,
        delegationId: grant.delegationId,
        workItemId: grant.workItemId,
        assignmentId: grant.assignmentId,
      }, this.now),
    });
    return grant;
  }

  revokeGrant(grantId: string, expectedVersion: number): ExecutionGrant {
    const grant = this.snapshot.grants.find((item) => item.id === grantId);
    if (!grant) throw new ExecutionNotFoundError('Grant not found.');
    if (grant.expectedVersion !== expectedVersion) {
      throw new ExecutionConflictError('Grant expectedVersion is stale.');
    }
    if (grant.state === 'revoked') return grant;
    const revoked = Object.freeze({
      ...grant,
      state: 'revoked' as const,
      expectedVersion: grant.expectedVersion + 1,
      revokedAt: this.now(),
    });
    this.snapshot = Object.freeze({
      ...this.snapshot,
      grants: this.snapshot.grants.map((item) => item.id === grant.id ? revoked : item),
      events: appendEvent(this.snapshot, 'execution.grant_revoked', {
        grantId: grant.id,
        expectedVersion: revoked.expectedVersion,
      }, this.now),
    });
    return revoked;
  }

  createRequest(input: unknown): ExecutionRequest {
    const parsed = parseCreateRequestInput(input);
    const grant = this.snapshot.grants.find((item) => item.id === parsed.grantId);
    if (!grant) throw new ExecutionNotFoundError('Grant not found.');
    if (grant.state !== 'granted') throw new ExecutionConflictError('Grant is not active.');
    if (grant.expectedVersion !== parsed.expectedGrantVersion) {
      throw new ExecutionConflictError('Grant expectedVersion is stale.');
    }
    if (grant.operation !== parsed.operation) {
      throw new ExecutionConflictError('Request operation does not match grant.');
    }
    const id = digest('xrq', JSON.stringify([
      parsed.grantId, parsed.expectedGrantVersion, parsed.operation,
      parsed.argumentsDigest, parsed.idempotencyKey,
    ]));
    const existing = this.snapshot.requests.find((item) => item.id === id);
    if (existing) return existing;
    const conflicting = this.snapshot.requests.find((item) => item.idempotencyKey === parsed.idempotencyKey);
    if (conflicting) throw new ExecutionConflictError('Execution idempotency key conflicts.');
    const request = Object.freeze({
      version: EXECUTION_CONTRACT_VERSION,
      id,
      grantId: grant.id,
      state: 'pending' as const,
      expectedVersion: 1,
      operation: parsed.operation,
      argumentsDigest: parsed.argumentsDigest,
      idempotencyKey: parsed.idempotencyKey,
      resultDigest: null,
      errorDigest: null,
      createdAt: this.now(),
      decidedAt: null,
      startedAt: null,
      finishedAt: null,
    });
    this.snapshot = Object.freeze({
      ...this.snapshot,
      requests: Object.freeze([...this.snapshot.requests, request]),
      events: appendEvent(this.snapshot, 'execution.request_created', {
        requestId: request.id,
        grantId: request.grantId,
        argumentsDigest: request.argumentsDigest,
        state: request.state,
      }, this.now),
    });
    return request;
  }

  async decideRequest(input: unknown): Promise<ExecutionRequest> {
    const parsed = parseDecideRequestInput(input);
    const request = this.snapshot.requests.find((item) => item.id === parsed.requestId);
    if (!request) throw new ExecutionNotFoundError('Execution request not found.');
    if (request.state !== 'pending') throw new ExecutionConflictError('Execution request is not pending.');
    if (request.expectedVersion !== parsed.expectedVersion) {
      throw new ExecutionConflictError('Execution request expectedVersion is stale.');
    }
    if (parsed.decision === 'rejected') {
      const rejected = Object.freeze({
        ...request,
        state: 'rejected' as const,
        expectedVersion: request.expectedVersion + 1,
        errorDigest: parsed.reasonDigest,
        decidedAt: this.now(),
      });
      this.replaceRequest(rejected);
      this.snapshot = Object.freeze({
        ...this.snapshot,
        events: appendEvent(this.snapshot, 'execution.request_rejected', {
          requestId: rejected.id,
          reasonDigest: parsed.reasonDigest,
        }, this.now),
      });
      return rejected;
    }

    const approved = Object.freeze({
      ...request,
      state: 'approved' as const,
      expectedVersion: request.expectedVersion + 1,
      decidedAt: this.now(),
    });
    this.replaceRequest(approved);
    this.snapshot = Object.freeze({
      ...this.snapshot,
      events: appendEvent(this.snapshot, 'execution.request_approved', {
        requestId: approved.id,
        reasonDigest: parsed.reasonDigest,
      }, this.now),
    });
    const running = Object.freeze({ ...approved, state: 'running' as const, startedAt: this.now() });
    this.replaceRequest(running);
    this.snapshot = Object.freeze({
      ...this.snapshot,
      events: appendEvent(this.snapshot, 'execution.started', { requestId: running.id }, this.now),
    });
    const result = await this.executor.execute(running);
    const finished = Object.freeze({
      ...running,
      state: result.outcome,
      resultDigest: result.resultDigest,
      errorDigest: result.errorDigest,
      expectedVersion: running.expectedVersion + 1,
      finishedAt: this.now(),
    });
    this.replaceRequest(finished);
    this.snapshot = Object.freeze({
      ...this.snapshot,
      events: appendEvent(this.snapshot,
        result.outcome === 'succeeded' ? 'execution.succeeded' : 'execution.failed', {
          requestId: finished.id,
          resultDigest: finished.resultDigest ?? '',
          errorDigest: finished.errorDigest ?? '',
        }, this.now),
    });
    return finished;
  }

  getRequest(requestId: string): ExecutionRequest {
    const request = this.snapshot.requests.find((item) => item.id === requestId);
    if (!request) throw new ExecutionNotFoundError('Execution request not found.');
    return request;
  }

  events(after?: string, limit = 100): readonly ExecutionEvent[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new ExecutionValidationError('limit must be an integer from 1 to 1000.');
    }
    const cursorIndex = after === undefined ? -1 : this.snapshot.events.findIndex((event) => event.id === after);
    if (after !== undefined && cursorIndex < 0) {
      throw new ExecutionValidationError('Unknown execution event cursor.');
    }
    return Object.freeze(this.snapshot.events.slice(cursorIndex + 1, cursorIndex + 1 + limit));
  }

  private replaceRequest(request: ExecutionRequest): void {
    this.snapshot = Object.freeze({
      ...this.snapshot,
      requests: this.snapshot.requests.map((item) => item.id === request.id ? request : item),
    });
  }
}
