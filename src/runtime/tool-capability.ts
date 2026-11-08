import { createHash } from 'node:crypto';
import type { ConfigurationRevisionId } from './configuration-revision.js';
import {
  appendEvent,
  createEventLog,
  type RuntimeEvent,
  type RuntimeEventLog,
} from './event-log.js';
import { TASK_TRANSITIONS, type TaskEventType } from './task-lifecycle.js';
import {
  ToolExecutionDeniedError,
  decideToolPolicy,
  type ToolDecision,
  type ToolPolicy,
} from './policy-gate.js';

export type ToolSideEffect = 'read' | 'write';
export type ToolApprovalDecision = 'approved' | 'rejected';
export type ToolRejectionDecision = ToolDecision | 'invalid';

export interface ToolArguments {
  readonly [key: string]: string | number | boolean | null;
}

export interface ToolDefinition {
  readonly name: string;
  readonly sideEffect: ToolSideEffect;
  readonly requiresApproval: boolean;
  readonly argumentKeys: readonly string[];
  readonly execute: (args: ToolArguments) => string;
}

export interface ToolApprovalRecord {
  readonly version: 1;
  readonly id: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly toolName: string;
  readonly argumentsDigest: string;
  readonly decision: ToolApprovalDecision;
  readonly reason: string;
  readonly createdAt: string;
}

export interface ToolExecutionRequest {
  readonly taskId: string;
  readonly attempt: number;
  readonly configurationRevisionId: ConfigurationRevisionId;
  readonly toolName: string;
  readonly args: ToolArguments;
  readonly approval?: ToolApprovalRecord;
}

export interface ToolExecutionRecord {
  readonly idempotencyKey: string;
  readonly decision: ToolDecision;
  readonly executed: boolean;
  readonly replayed: boolean;
  readonly resultDigest: string | null;
  readonly failureDigest: string | null;
}

export interface ToolCapabilityResult {
  readonly record: ToolExecutionRecord;
  readonly events: readonly RuntimeEvent[];
}

export type ToolAuditType = Extract<TaskEventType, `tool.${string}`>;

export interface ToolPolicyView {
  readonly allowedTools: readonly string[];
  readonly approvalRequiredTools: readonly string[];
}

type AuditScalar = string | number | boolean | null;

interface AuditIdentity {
  readonly taskId: string;
  readonly attempt: number;
  readonly configurationRevisionId: ConfigurationRevisionId;
  readonly toolName: string;
}

interface ExecutorOutcome {
  readonly resultDigest: string | null;
  readonly failureDigest: string | null;
}

interface AuditState {
  log: RuntimeEventLog;
}

export class ToolRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolRegistrationError';
  }
}

class ToolRequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolRequestValidationError';
  }
}

export class ToolExecutionRejectedError extends Error {
  readonly decision: ToolRejectionDecision;
  readonly events: readonly RuntimeEvent[];

  constructor(decision: ToolRejectionDecision, events: readonly RuntimeEvent[]) {
    super(`Tool execution is not authorized: ${decision}`);
    this.name = 'ToolExecutionRejectedError';
    this.decision = decision;
    this.events = events;
  }
}

export class ToolAuditDeniedError extends ToolExecutionRejectedError {
  constructor(decision: ToolDecision, events: readonly RuntimeEvent[]) {
    super(decision, events);
    this.name = 'ToolAuditDeniedError';
  }
}

export class ToolExecutorFailedError extends Error {
  readonly events: readonly RuntimeEvent[];

  constructor(events: readonly RuntimeEvent[]) {
    super('Tool executor failed.');
    this.name = 'ToolExecutorFailedError';
    this.events = events;
  }
}

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const ARGUMENT_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const ARGUMENT_DIGEST_PATTERN = /^[0-9a-f]{16}$/;
const CONFIGURATION_REVISION_PATTERN = /^cfg_[0-9a-f]{24}$/;
const RESULT_DIGEST_LENGTH = 16;
const MAX_TASK_ID_LENGTH = 200;
const MAX_APPROVAL_ID_LENGTH = 200;
const MAX_REASON_LENGTH = 500;
const MAX_ARGUMENT_STRING_LENGTH = 500;
const MAX_RESULT_LENGTH = 2000;
const MAX_ARGUMENT_COUNT = 8;
const INVALID_TASK_ID = 'invalid_task';
const INVALID_TOOL_NAME = 'invalid_tool';
const INVALID_CONFIGURATION_REVISION_ID = 'cfg_invalid' as ConfigurationRevisionId;

function isToolName(value: unknown): value is string {
  return typeof value === 'string' && TOOL_NAME_PATTERN.test(value);
}

function isArgumentKey(value: unknown): value is string {
  return typeof value === 'string' && ARGUMENT_KEY_PATTERN.test(value);
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, RESULT_DIGEST_LENGTH);
}

const INVALID_REQUEST_DIGEST = digest('invalid_request');
const EXECUTOR_ERROR_DIGEST = digest('executor_error');

function canonicalizeArguments(args: ToolArguments): string {
  return JSON.stringify(Object.keys(args).sort().map((key) => [key, args[key]]));
}

export function toolArgumentsDigest(args: ToolArguments): string {
  return digest(canonicalizeArguments(args));
}

function idempotencyKey(
  taskId: string,
  attempt: number,
  toolName: string,
  argsDigest: string,
): string {
  return digest(JSON.stringify([taskId, attempt, toolName, argsDigest]));
}

function auditIdentity(request: ToolExecutionRequest): AuditIdentity {
  const taskId = typeof request.taskId === 'string'
    && request.taskId.trim().length > 0
    && request.taskId.length <= MAX_TASK_ID_LENGTH
    ? request.taskId
    : INVALID_TASK_ID;
  const attempt = Number.isInteger(request.attempt)
    && request.attempt >= 1
    && request.attempt <= Number.MAX_SAFE_INTEGER
    ? request.attempt
    : 1;
  const configurationRevisionId = typeof request.configurationRevisionId === 'string'
    && CONFIGURATION_REVISION_PATTERN.test(request.configurationRevisionId)
    ? request.configurationRevisionId
    : INVALID_CONFIGURATION_REVISION_ID;
  const toolName = isToolName(request.toolName) ? request.toolName : INVALID_TOOL_NAME;
  return { taskId, attempt, configurationRevisionId, toolName };
}

function boundedAuditData(
  data: Readonly<Record<string, unknown>>,
): Readonly<Record<string, AuditScalar>> {
  const result: Record<string, AuditScalar> = {};
  for (const [key, value] of Object.entries(data)) {
    if (key.length > 64) continue;
    if (typeof value === 'string') {
      result[key] = value.length <= 200 ? value : digest(value);
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      result[key] = value;
    } else if (typeof value === 'boolean' || value === null) {
      result[key] = value;
    } else {
      result[key] = null;
    }
  }
  return Object.freeze(result);
}

function validateToolDefinition(definition: ToolDefinition): void {
  if (definition === null || typeof definition !== 'object') {
    throw new ToolRegistrationError('Tool definition must be an object.');
  }
  if (!isToolName(definition.name)) {
    throw new ToolRegistrationError('Tool name has an invalid format.');
  }
  if (definition.sideEffect !== 'read' && definition.sideEffect !== 'write') {
    throw new ToolRegistrationError('Tool side effect must be read or write.');
  }
  if (typeof definition.requiresApproval !== 'boolean') {
    throw new ToolRegistrationError('Tool approval requirement must be a boolean.');
  }
  if (typeof definition.execute !== 'function') {
    throw new ToolRegistrationError('Tool executor must be a function.');
  }
  if (!Array.isArray(definition.argumentKeys) || definition.argumentKeys.length > MAX_ARGUMENT_COUNT) {
    throw new ToolRegistrationError('A tool may declare at most 8 argument keys.');
  }
  const keys = new Set<string>();
  for (const key of definition.argumentKeys) {
    if (!isArgumentKey(key) || keys.has(key)) {
      throw new ToolRegistrationError('Tool argument keys must be unique and valid.');
    }
    keys.add(key);
  }
}

function validateRequest(request: ToolExecutionRequest, definition: ToolDefinition): string {
  if (
    typeof request.taskId !== 'string'
    || request.taskId.trim().length === 0
    || request.taskId.length > MAX_TASK_ID_LENGTH
    || typeof request.configurationRevisionId !== 'string'
    || !CONFIGURATION_REVISION_PATTERN.test(request.configurationRevisionId)
    || !Number.isInteger(request.attempt)
    || request.attempt < 1
    || request.attempt > Number.MAX_SAFE_INTEGER
    || !isToolName(request.toolName)
    || request.args === null
    || typeof request.args !== 'object'
    || Array.isArray(request.args)
  ) {
    throw new ToolRequestValidationError('Tool request identity is invalid.');
  }

  const prototype = Object.getPrototypeOf(request.args);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ToolRequestValidationError('Tool arguments must be a plain object.');
  }

  const argumentKeys = Object.keys(request.args);
  if (argumentKeys.length > MAX_ARGUMENT_COUNT) {
    throw new ToolRequestValidationError('Tool arguments exceed the accepted bound.');
  }
  for (const key of argumentKeys) {
    if (!isArgumentKey(key) || !definition.argumentKeys.includes(key)) {
      throw new ToolRequestValidationError('Tool argument key is not declared.');
    }
    const value = request.args[key];
    if (
      typeof value !== 'string'
      && typeof value !== 'number'
      && typeof value !== 'boolean'
      && value !== null
    ) {
      throw new ToolRequestValidationError('Tool argument value is not a bounded scalar.');
    }
    if (typeof value === 'string' && value.length > MAX_ARGUMENT_STRING_LENGTH) {
      throw new ToolRequestValidationError('Tool argument string exceeds the accepted bound.');
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new ToolRequestValidationError('Tool argument number must be finite.');
    }
  }
  return toolArgumentsDigest(request.args);
}

function isWellFormedApproval(value: unknown): value is ToolApprovalRecord {
  if (value === null || typeof value !== 'object') return false;
  const approval = value as Record<string, unknown>;
  return approval.version === 1
    && typeof approval.id === 'string'
    && approval.id.length > 0
    && approval.id.length <= MAX_APPROVAL_ID_LENGTH
    && typeof approval.taskId === 'string'
    && approval.taskId.trim().length > 0
    && approval.taskId.length <= MAX_TASK_ID_LENGTH
    && Number.isInteger(approval.attempt)
    && (approval.attempt as number) >= 1
    && (approval.attempt as number) <= Number.MAX_SAFE_INTEGER
    && isToolName(approval.toolName)
    && typeof approval.argumentsDigest === 'string'
    && ARGUMENT_DIGEST_PATTERN.test(approval.argumentsDigest)
    && (approval.decision === 'approved' || approval.decision === 'rejected')
    && typeof approval.reason === 'string'
    && approval.reason.length <= MAX_REASON_LENGTH
    && typeof approval.createdAt === 'string'
    && !Number.isNaN(Date.parse(approval.createdAt));
}

export class ToolRegistry {
  private readonly definitions: ReadonlyMap<string, ToolDefinition>;
  readonly policy: ToolPolicy;

  constructor(definitions: readonly ToolDefinition[]) {
    if (!Array.isArray(definitions)) {
      throw new ToolRegistrationError('Tool definitions must be an array.');
    }
    const entries = new Map<string, ToolDefinition>();
    const allowedTools: string[] = [];
    const approvalRequiredTools: string[] = [];

    for (const definition of definitions) {
      validateToolDefinition(definition);
      if (entries.has(definition.name)) {
        throw new ToolRegistrationError('Tool name is already registered.');
      }
      entries.set(definition.name, Object.freeze({
        name: definition.name,
        sideEffect: definition.sideEffect,
        requiresApproval: definition.requiresApproval,
        argumentKeys: Object.freeze([...definition.argumentKeys]),
        execute: definition.execute,
      }));
      if (definition.requiresApproval) approvalRequiredTools.push(definition.name);
      else allowedTools.push(definition.name);
    }

    this.definitions = entries;
    this.policy = Object.freeze({
      allowedTools: Object.freeze(allowedTools),
      approvalRequiredTools: Object.freeze(approvalRequiredTools),
    });
  }

  resolve(name: string): ToolDefinition | null {
    return typeof name === 'string' ? this.definitions.get(name) ?? null : null;
  }

  list(): readonly {
    readonly name: string;
    readonly sideEffect: ToolSideEffect;
    readonly requiresApproval: boolean;
  }[] {
    return Object.freeze([...this.definitions.values()].map((definition) => Object.freeze({
      name: definition.name,
      sideEffect: definition.sideEffect,
      requiresApproval: definition.requiresApproval,
    })));
  }
}

export interface ToolCapabilityKernelOptions {
  readonly registry: ToolRegistry;
}

export class ToolCapabilityKernel {
  private readonly registry: ToolRegistry;
  private readonly executions = new Map<string, ToolExecutionRecord>();

  constructor(options: ToolCapabilityKernelOptions) {
    this.registry = options.registry;
  }

  get policyView(): ToolPolicyView {
    return this.registry.policy;
  }

  execute(request: ToolExecutionRequest): ToolCapabilityResult {
    if (request === null || typeof request !== 'object') {
      throw new ToolExecutionRejectedError('invalid', Object.freeze([]));
    }

    const state: AuditState = { log: createEventLog() };
    const identity = auditIdentity(request);
    const requestedToolName = typeof request.toolName === 'string' ? request.toolName : '';
    const definition = this.registry.resolve(requestedToolName);
    if (!definition) {
      this.appendAudit(state, request, 'tool.requested', { toolName: identity.toolName });
      this.appendAudit(state, request, 'tool.denied', { decision: 'denied' });
      throw new ToolAuditDeniedError('denied', state.log.events);
    }

    let argsDigest: string;
    try {
      argsDigest = validateRequest(request, definition);
    } catch (cause) {
      if (!(cause instanceof ToolRequestValidationError)) throw cause;
      this.appendAudit(state, request, 'tool.requested', {
        toolName: identity.toolName,
        failureDigest: INVALID_REQUEST_DIGEST,
      });
      this.appendAudit(state, request, 'tool.denied', {
        decision: 'invalid',
        failureDigest: INVALID_REQUEST_DIGEST,
      });
      throw new ToolExecutionRejectedError('invalid', state.log.events);
    }

    const key = idempotencyKey(
      identity.taskId,
      identity.attempt,
      identity.toolName,
      argsDigest,
    );
    this.appendAudit(state, request, 'tool.requested', {
      toolName: identity.toolName,
      idempotencyKey: key,
    });

    const decision = decideToolPolicy(this.registry.policy, { toolName: identity.toolName });
    if (decision === 'denied') {
      this.appendAudit(state, request, 'tool.denied', { decision, idempotencyKey: key });
      throw new ToolAuditDeniedError(decision, state.log.events);
    }

    let approved = false;
    if (decision === 'approval_required') {
      this.appendAudit(state, request, 'tool.approval_required', {
        toolName: identity.toolName,
        idempotencyKey: key,
      });
      approved = this.matchesApproval(request.approval, request, argsDigest);
      this.appendAudit(state, request, approved ? 'tool.approved' : 'tool.rejected', {
        toolName: identity.toolName,
        idempotencyKey: key,
        approvalId: this.approvalIdDigest(request.approval),
      });
      if (!approved) {
        this.appendAudit(state, request, 'tool.denied', { decision, idempotencyKey: key });
        throw new ToolAuditDeniedError(decision, state.log.events);
      }
    }

    const previous = this.executions.get(key);
    if (previous) {
      this.appendReplayAudit(state, request, key, previous);
      if (previous.failureDigest !== null) {
        throw new ToolExecutorFailedError(state.log.events);
      }
      return {
        record: Object.freeze({ ...previous, replayed: true, executed: false }),
        events: state.log.events,
      };
    }

    const outcome = this.invokeExecutor(definition, request.args);
    const record: ToolExecutionRecord = Object.freeze({
      idempotencyKey: key,
      decision,
      executed: true,
      replayed: false,
      resultDigest: outcome.resultDigest,
      failureDigest: outcome.failureDigest,
    });
    this.executions.set(key, record);
    this.appendOutcomeAudit(
      state,
      request,
      key,
      decision === 'approval_required',
      approved,
      outcome,
    );
    if (outcome.failureDigest !== null) {
      throw new ToolExecutorFailedError(state.log.events);
    }
    return { record, events: state.log.events };
  }

  private approvalIdDigest(approval: ToolApprovalRecord | undefined): string | null {
    return isWellFormedApproval(approval) ? digest(approval.id) : null;
  }

  private invokeExecutor(
    definition: ToolDefinition,
    args: ToolArguments,
  ): ExecutorOutcome {
    try {
      const result = definition.execute(args);
      if (typeof result !== 'string' || result.length > MAX_RESULT_LENGTH) {
        return { resultDigest: null, failureDigest: EXECUTOR_ERROR_DIGEST };
      }
      return { resultDigest: digest(result), failureDigest: null };
    } catch {
      return { resultDigest: null, failureDigest: EXECUTOR_ERROR_DIGEST };
    }
  }

  private appendReplayAudit(
    state: AuditState,
    request: ToolExecutionRequest,
    key: string,
    record: ToolExecutionRecord,
  ): void {
    this.appendAudit(state, request, 'tool.replayed', {
      toolName: auditIdentity(request).toolName,
      idempotencyKey: key,
      resultDigest: record.resultDigest,
      failureDigest: record.failureDigest,
    });
    if (record.failureDigest !== null) {
      this.appendAudit(state, request, 'tool.failed', {
        toolName: auditIdentity(request).toolName,
        idempotencyKey: key,
        failureDigest: record.failureDigest,
      });
      throw new ToolExecutorFailedError(state.log.events);
    }
  }

  private appendOutcomeAudit(
    state: AuditState,
    request: ToolExecutionRequest,
    key: string,
    approvalRequired: boolean,
    approved: boolean,
    outcome: ExecutorOutcome,
  ): void {
    const type: ToolAuditType = outcome.failureDigest === null
      ? 'tool.executed'
      : 'tool.failed';
    this.appendAudit(state, request, type, {
      toolName: auditIdentity(request).toolName,
      idempotencyKey: key,
      resultDigest: outcome.resultDigest,
      failureDigest: outcome.failureDigest,
      approvalRequired,
      approved,
    });
  }

  private matchesApproval(
    approval: ToolApprovalRecord | undefined,
    request: ToolExecutionRequest,
    argsDigest: string,
  ): boolean {
    return isWellFormedApproval(approval)
      && approval.decision === 'approved'
      && approval.taskId === request.taskId
      && approval.attempt === request.attempt
      && approval.toolName === request.toolName
      && approval.argumentsDigest === argsDigest;
  }

  private appendAudit(
    state: AuditState,
    request: ToolExecutionRequest,
    type: ToolAuditType,
    data: Readonly<Record<string, unknown>>,
  ): void {
    const identity = auditIdentity(request);
    state.log = appendEvent(state.log, {
      taskId: identity.taskId,
      type,
      state: TASK_TRANSITIONS[type].state,
      configurationRevisionId: identity.configurationRevisionId,
      attempt: identity.attempt,
      data: boundedAuditData(data),
    });
  }
}
