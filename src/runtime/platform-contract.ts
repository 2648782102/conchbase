import { createHash } from 'node:crypto';

export const PLATFORM_CONTRACT_VERSION = 2;
export const WORK_STATES = Object.freeze(['open', 'running', 'paused', 'completed', 'cancelled'] as const);
export const ASSIGNMENT_STATES = Object.freeze(['planned', 'running', 'interrupted', 'succeeded', 'failed', 'cancelled'] as const);
export const OUTBOX_STATES = Object.freeze(['pending', 'sent', 'delivered', 'failed'] as const);
export const RECEIPT_STATES = Object.freeze(['observed', 'accepted', 'rejected'] as const);
export const CAPABILITY_KINDS = Object.freeze(['mcp', 'skill', 'plugin', 'secret-handle'] as const);

export type WorkState = typeof WORK_STATES[number];
export type AssignmentState = typeof ASSIGNMENT_STATES[number];
export type OutboxState = typeof OUTBOX_STATES[number];
export type ReceiptState = typeof RECEIPT_STATES[number];
export type CapabilityKind = typeof CAPABILITY_KINDS[number];

export class PlatformValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlatformValidationError';
  }
}
export class PlatformConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlatformConflictError';
  }
}
export class PlatformNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlatformNotFoundError';
  }
}

export interface PairingSession {
  readonly version: typeof PLATFORM_CONTRACT_VERSION;
  readonly id: string;
  readonly status: 'pending' | 'approved' | 'revoked';
  readonly label: string;
  readonly createdAt: string;
  readonly approvedAt: string | null;
  readonly challengeDigest: string;
}
export interface AuthToken {
  readonly version: typeof PLATFORM_CONTRACT_VERSION;
  readonly id: string;
  readonly pairingId: string;
  readonly name: string;
  readonly tokenDigest: string;
  readonly createdAt: string;
  readonly revokedAt: string | null;
}
export interface LocalSourceEvent {
  readonly version: typeof PLATFORM_CONTRACT_VERSION;
  readonly id: string;
  readonly sourceId: string;
  readonly threadKey: string;
  readonly payloadDigest: string;
  readonly occurredAt: string;
  readonly policy: 'allow' | 'deny';
  readonly mandateDigest: string;
}
export interface CapabilityRecord {
  readonly version: typeof PLATFORM_CONTRACT_VERSION;
  readonly id: string;
  readonly kind: CapabilityKind;
  readonly name: string;
  readonly status: 'enabled' | 'disabled';
  readonly descriptor: string;
  readonly createdAt: string;
}
export interface SecretHandle {
  readonly version: typeof PLATFORM_CONTRACT_VERSION;
  readonly id: string;
  readonly key: string;
  readonly secretVersion: number;
  readonly status: 'active' | 'disabled';
  readonly purpose: string;
  readonly allowedAdapter: string;
  readonly destinationBinding: string;
  readonly valueDigest: string;
  readonly createdAt: string;
  readonly rotatedAt: string | null;
}
export interface SecretHandleUseReceipt {
  readonly version: typeof PLATFORM_CONTRACT_VERSION;
  readonly id: string;
  readonly handleId: string;
  readonly secretVersionDigest: string;
  readonly grantRevision: string;
  readonly adapterId: string;
  readonly destinationDigest: string;
  readonly outcome: 'injected' | 'denied';
  readonly workItemId: string;
  readonly assignmentId: string;
  readonly createdAt: string;
}
export interface WorkSnapshot {
  readonly version: typeof PLATFORM_CONTRACT_VERSION;
  readonly id: string;
  readonly state: WorkState;
  readonly threadId: string;
  readonly triggerId: string;
  readonly mandateId: string;
  readonly mandateRevision: 1;
}
export interface PlatformWorkDetail {
  readonly version: typeof PLATFORM_CONTRACT_VERSION;
  readonly workItem: WorkSnapshot;
  readonly thread: {
    readonly version: typeof PLATFORM_CONTRACT_VERSION;
    readonly id: string;
    readonly threadKey: string;
    readonly contextOnly: true;
    readonly triggerIds: readonly string[];
    readonly workItemId: string;
  };
  readonly mandate: {
    readonly version: typeof PLATFORM_CONTRACT_VERSION;
    readonly id: string;
    readonly workItemId: string;
    readonly revision: 1;
    readonly scope: readonly string[];
    readonly allowedOperations: readonly string[];
    readonly capabilitiesDigest: string;
  };
  readonly assignments: readonly {
    readonly version: typeof PLATFORM_CONTRACT_VERSION;
    readonly id: string;
    readonly workItemId: string;
    readonly state: AssignmentState;
    readonly agentRevisionId: string;
    readonly configurationRevisionId: string;
    readonly mandateRevision: 1;
    readonly model: { readonly providerId: string; readonly modelId: string };
  }[];
  readonly outbox: readonly {
    readonly version: typeof PLATFORM_CONTRACT_VERSION;
    readonly id: string;
    readonly workItemId: string;
    readonly assignmentId: string;
    readonly status: OutboxState;
    readonly destinationDigest: string;
    readonly payloadDigest: string;
  }[];
  readonly deliveryReceipts: readonly {
    readonly version: typeof PLATFORM_CONTRACT_VERSION;
    readonly id: string;
    readonly workItemId: string;
    readonly outboxId: string;
    readonly status: ReceiptState;
    readonly destinationDigest: string;
    readonly payloadDigest: string;
  }[];
}
export interface WorkEventRecord {
  readonly version: typeof PLATFORM_CONTRACT_VERSION;
  readonly id: string;
  readonly sequence: number;
  readonly type: string;
  readonly workItemId: string;
  readonly data: Readonly<Record<string, string | number | boolean>>;
}

const digestPattern = /^sha256:[0-9a-f]{64}$/;
const forbiddenTopologyWords = /\b(?:router|worker|three-layer|layered|hierarchy)\b/i;
const secretLike = /secret|credential|token|apiKey|Authorization/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const unexpected = Object.keys(value).filter((key) => !keys.includes(key));
  if (unexpected.length > 0) throw new PlatformValidationError(`${label} contains unknown field ${unexpected[0]}.`);
  for (const key of keys) if (!(key in value)) throw new PlatformValidationError(`${label}.${key} is required.`);
}
function boundedString(value: unknown, label: string, maxLength = 120): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new PlatformValidationError(`${label} must be a non-empty string of at most ${maxLength} characters.`);
  }
  if (value.includes('/') || value.includes('\\') || value.includes('://')) {
    throw new PlatformValidationError(`${label} must not contain a path or URL.`);
  }
  if (secretLike.test(value) || forbiddenTopologyWords.test(value)) {
    throw new PlatformValidationError(`${label} contains a forbidden term.`);
  }
  return value;
}
function opaqueString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{0,127}$/i.test(value)) {
    throw new PlatformValidationError(`${label} must be an opaque identifier.`);
  }
  return value;
}
function digestValue(value: unknown, label: string): string {
  const text = boundedString(value, label, 71);
  if (!digestPattern.test(text)) throw new PlatformValidationError(`${label} must be a sha256:<64 lowercase hex> digest.`);
  return text;
}
function timestamp(value: unknown, label: string): string {
  const text = boundedString(value, label, 40);
  if (Number.isNaN(Date.parse(text))) throw new PlatformValidationError(`${label} must be an ISO-8601 date.`);
  return text;
}
function secretValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    throw new PlatformValidationError(`${label} must be a non-empty string of at most 4096 characters.`);
  }
  return value;
}

export function sha256Digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}
export function rawSha256Digest(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}
export function secretValueDigest(value: string): string {
  return rawSha256Digest(value);
}
export function opaquePlatformId(prefix: string, value: unknown): string {
  return `${prefix}_${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24)}`;
}
export function tokenDigest(value: string): string {
  return rawSha256Digest(value);
}

export function parsePairingCreate(body: unknown): { label: string } {
  const value = isRecord(body) ? body : {};
  assertExactKeys(value, ['label'], 'Pairing request');
  return Object.freeze({ label: boundedString(value.label, 'label', 80) });
}
export function parsePairingApprove(body: unknown): { pairingId: string; challengeDigest: string } {
  const value = isRecord(body) ? body : {};
  assertExactKeys(value, ['pairingId', 'challengeDigest'], 'Pairing approval');
  return Object.freeze({
    pairingId: opaqueString(value.pairingId, 'pairingId'),
    challengeDigest: digestValue(value.challengeDigest, 'challengeDigest'),
  });
}
export function parseTokenCreate(body: unknown): { pairingId: string; name: string; tokenDigest: string } {
  const value = isRecord(body) ? body : {};
  assertExactKeys(value, ['pairingId', 'name', 'tokenDigest'], 'Token request');
  return Object.freeze({
    pairingId: opaqueString(value.pairingId, 'pairingId'),
    name: boundedString(value.name, 'name', 80),
    tokenDigest: digestValue(value.tokenDigest, 'tokenDigest'),
  });
}
export function parseSourceEvent(body: unknown): Omit<LocalSourceEvent, 'version' | 'id'> {
  const value = isRecord(body) ? body : {};
  assertExactKeys(value, ['sourceId', 'threadKey', 'payloadDigest', 'occurredAt', 'policy', 'mandateDigest'], 'Source event');
  if (value.policy !== 'allow' && value.policy !== 'deny') throw new PlatformValidationError('policy must be allow or deny.');
  return Object.freeze({
    sourceId: boundedString(value.sourceId, 'sourceId'),
    threadKey: boundedString(value.threadKey, 'threadKey'),
    payloadDigest: digestValue(value.payloadDigest, 'payloadDigest'),
    occurredAt: timestamp(value.occurredAt, 'occurredAt'),
    policy: value.policy,
    mandateDigest: digestValue(value.mandateDigest, 'mandateDigest'),
  });
}
export function parseCapabilityWrite(body: unknown): { kind: CapabilityKind; name: string; status: 'enabled' | 'disabled'; descriptor: string } {
  const value = isRecord(body) ? body : {};
  assertExactKeys(value, ['kind', 'name', 'status', 'descriptor'], 'Capability record');
  if (!CAPABILITY_KINDS.includes(value.kind as CapabilityKind)) throw new PlatformValidationError('kind must be mcp, skill, plugin, or secret-handle.');
  if (value.status !== 'enabled' && value.status !== 'disabled') throw new PlatformValidationError('status must be enabled or disabled.');
  return Object.freeze({
    kind: value.kind as CapabilityKind,
    name: boundedString(value.name, 'name'),
    status: value.status,
    descriptor: boundedString(value.descriptor, 'descriptor', 200),
  });
}
export function parseSecretHandleCreate(body: unknown): { key: string; value: string; purpose: string; allowedAdapter: string; destinationBinding: string } {
  const value = isRecord(body) ? body : {};
  assertExactKeys(value, ['key', 'value', 'purpose', 'allowedAdapter', 'destinationBinding'], 'SecretHandle create');
  return Object.freeze({
    key: boundedString(value.key, 'key'),
    value: secretValue(value.value, 'value'),
    purpose: boundedString(value.purpose, 'purpose', 200),
    allowedAdapter: boundedString(value.allowedAdapter, 'allowedAdapter', 80),
    destinationBinding: boundedString(value.destinationBinding, 'destinationBinding', 80),
  });
}
export function parseSecretHandleRotate(body: unknown): { value: string } {
  const value = isRecord(body) ? body : {};
  assertExactKeys(value, ['value'], 'SecretHandle rotation');
  return Object.freeze({ value: secretValue(value.value, 'value') });
}
export function parseSecretHandleStatus(body: unknown): { status: 'active' | 'disabled' } {
  const value = isRecord(body) ? body : {};
  assertExactKeys(value, ['status'], 'SecretHandle status');
  if (value.status !== 'active' && value.status !== 'disabled') throw new PlatformValidationError('status must be active or disabled.');
  return Object.freeze({ status: value.status });
}
export function parseSecretHandleUse(body: unknown): { handleId: string; workItemId: string; assignmentId: string; grantRevision: string } {
  const value = isRecord(body) ? body : {};
  assertExactKeys(value, ['handleId', 'workItemId', 'assignmentId', 'grantRevision'], 'SecretHandle use');
  return Object.freeze({
    handleId: opaqueString(value.handleId, 'handleId'),
    workItemId: opaqueString(value.workItemId, 'workItemId'),
    assignmentId: opaqueString(value.assignmentId, 'assignmentId'),
    grantRevision: opaqueString(value.grantRevision, 'grantRevision'),
  });
}
export function parseWorkControl(body: unknown): { expectedState: WorkState } {
  const value = isRecord(body) ? body : {};
  assertExactKeys(value, ['expectedState'], 'Work control');
  if (!WORK_STATES.includes(value.expectedState as WorkState)) throw new PlatformValidationError('expectedState is not a WorkItem state.');
  return Object.freeze({ expectedState: value.expectedState as WorkState });
}
export function parseReceiptDecision(body: unknown): { decision: 'accepted' | 'rejected' } {
  const value = isRecord(body) ? body : {};
  assertExactKeys(value, ['decision'], 'Delivery decision');
  if (value.decision !== 'accepted' && value.decision !== 'rejected') throw new PlatformValidationError('decision must be accepted or rejected.');
  return Object.freeze({ decision: value.decision });
}
export function parseRecovery(body: unknown): { outcome: 'succeeded' | 'failed' } {
  const value = isRecord(body) ? body : {};
  assertExactKeys(value, ['outcome'], 'Recovery');
  if (value.outcome !== 'succeeded' && value.outcome !== 'failed') throw new PlatformValidationError('outcome must be succeeded or failed.');
  return Object.freeze({ outcome: value.outcome });
}
