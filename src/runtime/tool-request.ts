import { createHash } from 'node:crypto';
import type { CompositionExecutionPlan } from './composition-execution.js';

export type ToolRequestStatus = 'approved' | 'pending' | 'rejected';
export type ToolRequestDecision = 'approved' | 'rejected';

export interface ToolCallArguments {
  readonly [key: string]: string | number | boolean | null;
}

export interface ToolCallProposal {
  readonly toolName: string;
  readonly arguments: ToolCallArguments;
}

export interface ToolRequestInput {
  readonly taskId: string;
  readonly attempt: number;
  readonly compositionNodeId: string;
  readonly toolCall: ToolCallProposal;
}

export interface ToolRequestIdentity {
  readonly configurationRevisionId: string;
  readonly compositionDocumentId: string;
  readonly compositionNodeId: string;
  readonly toolName: string;
  readonly argumentsDigest: string;
}

export interface ToolRequestRecord {
  readonly version: 1;
  readonly id: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly configurationRevisionId: string;
  readonly compositionDocumentId: string;
  readonly compositionNodeId: string;
  readonly toolName: string;
  readonly argumentsDigest: string;
  readonly idempotencyKey: string;
  readonly status: ToolRequestStatus;
  readonly createdAt: string;
  readonly approval: ToolRequestApproval | null;
}

export interface ToolRequestApproval {
  readonly id: string;
  readonly decision: ToolRequestDecision;
  readonly reasonDigest: string;
  readonly decidedAt: string;
}

export interface ParsedToolRequestDecision {
  readonly decision: ToolRequestDecision;
  readonly reasonDigest: string;
}

export interface ToolRequestValidationIssue {
  readonly path: string;
  readonly reason: string;
}

export class ToolRequestValidationError extends Error {
  readonly details: readonly ToolRequestValidationIssue[];

  constructor(details: readonly ToolRequestValidationIssue[]) {
    super('Tool request does not match the versioned contract.');
    this.name = 'ToolRequestValidationError';
    this.details = Object.freeze([...details]);
  }
}

export class ToolRequestContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolRequestContextError';
  }
}

export class ToolRequestNotFoundError extends Error {
  constructor() {
    super('Tool request not found.');
    this.name = 'ToolRequestNotFoundError';
  }
}

export class ToolRequestConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolRequestConflictError';
  }
}

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const COMPOSITION_NODE_ID_PATTERN = /^[a-z][a-z0-9_.-]{0,127}$/;
const ARGUMENT_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const SECRET_LIKE = /\b(?:api[_-]?key|access[_-]?token|token|password|secret|credential|private[_-]?key)\b/i;
const SECRET_VALUE = /(?:sk-|ghp_|github_pat_|Bearer\s+|[A-Za-z0-9+/]{40,}={0,2})/i;
const ABSOLUTE_URL = /^[a-z]+:\/\//i;
const MAX_ARGUMENT_COUNT = 8;
const MAX_ARGUMENT_STRING_LENGTH = 500;
const MAX_REASON_LENGTH = 500;
const MAX_TASK_ID_LENGTH = 200;

function digest(prefix: string, value: string): string {
  return `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= maxLength
    && !value.includes('\0');
}

function isSensitiveText(value: string): boolean {
  return SECRET_LIKE.test(value) || SECRET_VALUE.test(value) || ABSOLUTE_URL.test(value);
}

function canonicalizeArguments(args: ToolCallArguments): string {
  return JSON.stringify(Object.keys(args).sort().map((key) => [key, args[key]]));
}

export function toolArgumentsDigest(args: ToolCallArguments): string {
  return digest('arg', `conchbase-tool-arguments-v1\0${canonicalizeArguments(args)}`);
}

export function toolRequestIdempotencyKey(input: {
  readonly taskId: string;
  readonly attempt: number;
  readonly configurationRevisionId: string;
  readonly compositionDocumentId: string;
  readonly compositionNodeId: string;
  readonly toolName: string;
  readonly argumentsDigest: string;
}): string {
  return digest('idem', `conchbase-tool-request-v1\0${JSON.stringify([
    input.taskId,
    input.attempt,
    input.configurationRevisionId,
    input.compositionDocumentId,
    input.compositionNodeId,
    input.toolName,
    input.argumentsDigest,
  ])}`);
}

export function toolRequestId(idempotencyKey: string): string {
  return digest('tqr', `conchbase-tool-request-id-v1\0${idempotencyKey}`);
}

export function toolApprovalId(
  requestId: string,
  decision: ToolRequestDecision,
  reasonDigest: string,
): string {
  return digest('tap', `conchbase-tool-approval-v1\0${JSON.stringify([
    requestId,
    decision,
    reasonDigest,
  ])}`);
}

export function toolRequestReasonDigest(reason: string): string {
  return digest('rsn', `conchbase-tool-approval-reason-v1\0${reason}`);
}

export function validateToolCallProposal(
  input: unknown,
  issues: ToolRequestValidationIssue[],
): ToolCallProposal | null {
  if (!isRecord(input)) {
    issues.push({ path: 'toolCall', reason: 'must be an object' });
    return null;
  }
  const acceptedKeys = ['toolName', 'arguments'];
  if (Object.keys(input).some((key) => !acceptedKeys.includes(key))) {
    issues.push({ path: 'toolCall', reason: 'has unknown fields' });
  }
  const toolName = input.toolName;
  if (!isBoundedString(toolName, 64) || !TOOL_NAME_PATTERN.test(toolName)
    || (typeof toolName === 'string' && isSensitiveText(toolName))) {
    issues.push({ path: 'toolCall.toolName', reason: 'must be a bounded opaque tool identifier' });
  }
  const args = input.arguments;
  if (!isRecord(args)) {
    issues.push({ path: 'toolCall.arguments', reason: 'must be an object' });
    return typeof toolName === 'string' && TOOL_NAME_PATTERN.test(toolName)
      ? Object.freeze({ toolName, arguments: Object.freeze({}) })
      : null;
  }
  const keys = Object.keys(args);
  if (keys.length > MAX_ARGUMENT_COUNT) {
    issues.push({ path: 'toolCall.arguments', reason: 'has too many entries' });
  }
  const result: Record<string, string | number | boolean | null> = {};
  for (const key of keys) {
    const path = `toolCall.arguments.${key}`;
    const value = args[key];
    if (!ARGUMENT_KEY_PATTERN.test(key) || SECRET_LIKE.test(key)) {
      issues.push({ path, reason: 'key must be a bounded opaque identifier' });
      continue;
    }
    if (typeof value === 'string') {
      if (value.length > MAX_ARGUMENT_STRING_LENGTH || isSensitiveText(value)) {
        issues.push({ path, reason: 'value must be a bounded non-secret scalar' });
        continue;
      }
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        issues.push({ path, reason: 'number must be finite' });
        continue;
      }
    } else if (typeof value !== 'boolean' && value !== null) {
      issues.push({ path, reason: 'value must be a bounded scalar' });
      continue;
    }
    result[key] = value;
  }
  if (typeof toolName !== 'string' || !TOOL_NAME_PATTERN.test(toolName)) return null;
  return Object.freeze({ toolName, arguments: Object.freeze(result) });
}

export function parseToolRequestInput(input: unknown): ToolRequestInput {
  const issues: ToolRequestValidationIssue[] = [];
  if (!isRecord(input)) throw new ToolRequestValidationError([{ path: '$', reason: 'must be an object' }]);
  const acceptedKeys = ['taskId', 'attempt', 'compositionNodeId', 'toolCall'];
  if (Object.keys(input).some((key) => !acceptedKeys.includes(key))) {
    issues.push({ path: '$', reason: 'has unknown fields' });
  }
  if (!isBoundedString(input.taskId, MAX_TASK_ID_LENGTH)) {
    issues.push({ path: 'taskId', reason: 'must be a bounded non-empty string' });
  }
  if (!Number.isInteger(input.attempt) || (input.attempt as number) < 1) {
    issues.push({ path: 'attempt', reason: 'must be a positive integer' });
  }
  if (!isBoundedString(input.compositionNodeId, 128)
    || !COMPOSITION_NODE_ID_PATTERN.test(input.compositionNodeId)
    || (typeof input.compositionNodeId === 'string' && isSensitiveText(input.compositionNodeId))) {
    issues.push({ path: 'compositionNodeId', reason: 'must be a bounded opaque composition node id' });
  }
  const toolCall = validateToolCallProposal(input.toolCall, issues);
  if (issues.length > 0) throw new ToolRequestValidationError(issues);
  if (toolCall === null) throw new ToolRequestValidationError([{ path: 'toolCall', reason: 'is invalid' }]);
  return Object.freeze({
    taskId: input.taskId as string,
    attempt: input.attempt as number,
    compositionNodeId: input.compositionNodeId as string,
    toolCall,
  });
}

export function parseToolRequestDecision(input: unknown): ParsedToolRequestDecision {
  const issues: ToolRequestValidationIssue[] = [];
  if (!isRecord(input)) throw new ToolRequestValidationError([{ path: '$', reason: 'must be an object' }]);
  const acceptedKeys = ['decision', 'reason'];
  if (Object.keys(input).some((key) => !acceptedKeys.includes(key))) {
    issues.push({ path: '$', reason: 'has unknown fields' });
  }
  if (input.decision !== 'approved' && input.decision !== 'rejected') {
    issues.push({ path: 'decision', reason: 'must be approved or rejected' });
  }
  if (!isBoundedString(input.reason, MAX_REASON_LENGTH)
    || (typeof input.reason === 'string' && isSensitiveText(input.reason))) {
    issues.push({ path: 'reason', reason: 'must be a bounded non-empty string' });
  }
  if (issues.length > 0) throw new ToolRequestValidationError(issues);
  return Object.freeze({
    decision: input.decision as ToolRequestDecision,
    reasonDigest: toolRequestReasonDigest(input.reason as string),
  });
}

export function toolRequestIdentity(
  input: ToolRequestInput,
  plan: CompositionExecutionPlan,
  configurationRevisionId: string,
): ToolRequestIdentity {
  if (!plan.declaredNodeIds.includes(input.compositionNodeId)) {
    throw new ToolRequestContextError('Composition node is not declared by the pinned revision.');
  }
  const argumentsDigest = toolArgumentsDigest(input.toolCall.arguments);
  return Object.freeze({
    configurationRevisionId,
    compositionDocumentId: plan.compositionDocumentId,
    compositionNodeId: input.compositionNodeId,
    toolName: input.toolCall.toolName,
    argumentsDigest,
  });
}
