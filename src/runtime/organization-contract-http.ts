import { createHash } from 'node:crypto';
import {
  OrganizationConflictError,
  OrganizationNotFoundError,
  OrganizationValidationError,
  parseOrganizationAction,
  type OrganizationAction,
} from './organization-contract.js';
import {
  ORGANIZATION_PUBLIC_CONTRACT_VERSION,
} from './organization-public-contract.js';
import type { OrganizationStore } from './organization-store.js';

export class OrganizationIntentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrganizationIntentValidationError';
  }
}

export interface OrganizationIntentSubmission {
  readonly text: string;
  readonly idempotencyKey: string;
  readonly expectedSequence: number;
}

export interface OrganizationIntentRecord {
  readonly version: typeof ORGANIZATION_PUBLIC_CONTRACT_VERSION;
  readonly intentId: string;
  readonly state: 'accepted';
  readonly expectedSequence: number;
}

export interface OrganizationAttentionSubmission {
  readonly expectedVersion: number;
  readonly decisionDigest?: string;
}

export interface OrganizationEventPageQuery {
  readonly after?: string;
  readonly limit?: string;
}

export interface OrganizationIntentResult {
  readonly version: typeof ORGANIZATION_PUBLIC_CONTRACT_VERSION;
  readonly intentId: string;
  readonly state: 'accepted';
  readonly expectedSequence: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    throw new OrganizationIntentValidationError(`${label} must be a non-empty string of at most ${maximum} characters.`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new OrganizationIntentValidationError(`${label} contains unsupported characters.`);
  }
  return value;
}

function boundedInteger(value: unknown, label: string, minimum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum) {
    throw new OrganizationIntentValidationError(`${label} must be an integer of at least ${minimum}.`);
  }
  return value as number;
}

export function parseOrganizationIntentSubmission(input: unknown): OrganizationIntentSubmission {
  if (!isRecord(input)) throw new OrganizationIntentValidationError('Intent submission must be an object.');
  const allowed = new Set(['text', 'idempotencyKey', 'expectedSequence']);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new OrganizationIntentValidationError(`Intent submission has unknown fields: ${unknown.sort().join(', ')}.`);
  }
  const text = boundedString(input.text, 'text', 20_000);
  if (/sk-|Bearer|github_pat_|ghp_|password|apiKey|privateKey/i.test(text)) {
    throw new OrganizationIntentValidationError('Intent text contains secret-like content.');
  }
  return Object.freeze({
    text,
    idempotencyKey: boundedString(input.idempotencyKey, 'idempotencyKey', 200),
    expectedSequence: boundedInteger(input.expectedSequence, 'expectedSequence', 0),
  });
}

export function parseOrganizationActionSubmission(input: unknown): OrganizationAction {
  if (!isRecord(input)) throw new OrganizationIntentValidationError('Action submission must be an object.');
  if ('intent' in input) {
    const submission = parseOrganizationIntentSubmission(input.intent);
    const intentId = organizationIntentId(submission.idempotencyKey);
    const parsed = parseOrganizationAction({
      type: 'open_project',
      expectedSequence: submission.expectedSequence,
      projectId: `project_${createHash('sha256')
        .update(`organization-intent:${submission.idempotencyKey}`)
        .digest('hex')
        .slice(0, 24)}`,
      originTriggerId: intentId,
    });
    return parsed;
  }
  if ('action' in input) return parseOrganizationAction(input.action);
  return parseOrganizationAction(input);
}

export function organizationIntentId(idempotencyKey: string): string {
  return `int_${createHash('sha256').update(`intent:${idempotencyKey}`).digest('hex').slice(0, 24)}`;
}

export function organizationIntentFingerprint(submission: OrganizationIntentSubmission): string {
  return createHash('sha256')
    .update(JSON.stringify([
      submission.text,
      submission.idempotencyKey,
      submission.expectedSequence,
    ]))
    .digest('hex');
}

export function organizationIntentResult(
  intentId: string,
  expectedSequence: number,
): OrganizationIntentResult {
  return Object.freeze({
    version: ORGANIZATION_PUBLIC_CONTRACT_VERSION,
    intentId,
    state: 'accepted' as const,
    expectedSequence,
  });
}

export function organizationAttentionVersion(request: { readonly sequence: number }): number {
  return request.sequence;
}

export function parseAttentionSubmission(input: unknown): OrganizationAttentionSubmission {
  if (!isRecord(input)) throw new OrganizationIntentValidationError('Attention submission must be an object.');
  const allowed = new Set(['expectedVersion', 'decisionDigest']);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new OrganizationIntentValidationError(`Attention submission has unknown fields: ${unknown.sort().join(', ')}.`);
  }
  const expectedVersion = boundedInteger(input.expectedVersion, 'expectedVersion', 1);
  if (input.decisionDigest === undefined) return Object.freeze({ expectedVersion });
  return Object.freeze({
    expectedVersion,
    decisionDigest: boundedString(input.decisionDigest, 'decisionDigest', 128),
  });
}

export function isOrganizationValidationError(cause: unknown): boolean {
  return cause instanceof OrganizationValidationError
    || cause instanceof OrganizationConflictError
    || cause instanceof OrganizationNotFoundError
    || cause instanceof OrganizationIntentValidationError;
}

export function parseOrganizationEventQuery(input: unknown): OrganizationEventPageQuery {
  if (input === undefined) return Object.freeze({});
  if (!isRecord(input)) throw new OrganizationIntentValidationError('Event query must be an object.');
  const allowed = new Set(['after', 'limit']);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new OrganizationIntentValidationError(`Event query has unknown fields: ${unknown.sort().join(', ')}.`);
  }
  const after = input.after === undefined
    ? undefined
    : boundedString(input.after, 'after', 200);
  if (after !== undefined && !/^evt_[a-z0-9]+$/.test(after)) {
    throw new OrganizationIntentValidationError('after must be an opaque organization event id.');
  }
  const limit = input.limit === undefined ? undefined : boundedEventLimit(input.limit);
  return Object.freeze({ ...(after === undefined ? {} : { after }), ...(limit === undefined ? {} : { limit }) });
}

function boundedEventLimit(input: unknown): string {
  if (typeof input !== 'string' && typeof input !== 'number') {
    throw new OrganizationIntentValidationError('limit must be an integer from 1 to 1000.');
  }
  const raw = typeof input === 'string' ? input.trim() : String(input);
  if (!/^\d+$/.test(raw)) throw new OrganizationIntentValidationError('limit must be an integer from 1 to 1000.');
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new OrganizationIntentValidationError('limit must be an integer from 1 to 1000.');
  }
  return raw;
}

export function organizationEventCursor(input: string | undefined): string | undefined {
  if (input === undefined) return undefined;
  if (!/^evt_[a-z0-9]+$/.test(input)) {
    throw new OrganizationIntentValidationError('after must be an opaque organization event id.');
  }
  return input;
}

export function organizationEventLimit(input: string | undefined): number {
  if (input === undefined) return 100;
  return Number(boundedEventLimit(input));
}

export function requireOrganizationStore(store: OrganizationStore | undefined): OrganizationStore {
  if (!store) throw new OrganizationNotFoundError('Organization store is not configured.');
  return store;
}
