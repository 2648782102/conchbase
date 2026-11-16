import { createHash } from 'node:crypto';

/**
 * Field-level validation primitives for organization actions.
 *
 * These are the rules that decide what a bounded, opaque, secret-free action
 * looks like. They are separated from the state machine because they answer a
 * different question: "is this value acceptable at all" versus "is this
 * transition legal right now". Every parser below rejects rather than repairs —
 * repair belongs in the declarative field contract, not here.
 */

export const MAX_DELEGATION_DEPTH = 3;
export const MAX_TTL_EVENTS = 1000;
export const MAX_ACTIVE_WORKERS_PER_PROJECT = 4;
export const MAX_ARRAY_LENGTH = 32;
export const MAX_STRING_LENGTH = 240;
export const MAX_DIGEST_LENGTH = 128;

/** Provider-neutral model reference. Lives here so validators stay dependency-free. */
export interface OrganizationModelReference {
  readonly providerId: string;
  readonly modelId: string;
}

export class OrganizationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrganizationValidationError';
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  const canonical: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) canonical[key] = canonicalize(value[key]);
  return canonical;
}

export function digest(kind: string, value: unknown): string {
  return createHash('sha256')
    .update(`${kind}:${JSON.stringify(canonicalize(value))}`)
    .digest('hex');
}

export function opaqueId(kind: string, value: unknown): string {
  return `${kind}_${digest(kind, value).slice(0, 24)}`;
}

export function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  label: string,
  optional: readonly string[] = [],
): void {
  const allowed = [...required, ...optional];
  const allowedSet = new Set(allowed);
  const unknownKeys = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknownKeys.length > 0) {
    throw new OrganizationValidationError(`${label} has unknown fields: ${unknownKeys.sort().join(', ')}`);
  }
  for (const key of required) {
    if (!(key in value)) throw new OrganizationValidationError(`${label} is missing ${key}.`);
  }
}

export function rejectSecretLike(value: unknown, path = 'action', depth = 0): void {
  if (depth > 8) throw new OrganizationValidationError(`${path} is too deep.`);
  const secretKey = /(secret|password|passwd|token|api[_-]?key|credential|plaintext|private[_-]?key)/i;
  if (typeof value === 'string') {
    if (/(^|\s)(sk-|Bearer\s|ghp_|github_pat_)/i.test(value)) {
      throw new OrganizationValidationError(`${path} contains secret-like text.`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectSecretLike(item, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (secretKey.test(key)) throw new OrganizationValidationError(`${path}.${key} is not accepted.`);
    rejectSecretLike(nested, `${path}.${key}`, depth + 1);
  }
}

export function boundedString(value: unknown, label: string, max = MAX_STRING_LENGTH): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new OrganizationValidationError(`${label} must be a non-empty string of at most ${max} characters.`);
  }
  // Worker instructions are naturally multi-line, so newline and carriage
  // return are allowed. Every other control character stays rejected.
  if (value.trim() !== value || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new OrganizationValidationError(`${label} contains unsupported characters.`);
  }
  return value;
}

/**
 * Same bounds as `boundedString`, but tolerates leading and trailing newlines
 * because this value is prose that a user or a model wrote, not an identifier.
 * Interior control characters are still rejected.
 */
export function boundedProse(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw new OrganizationValidationError(`${label} must be a non-empty string of at most ${max} characters.`);
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new OrganizationValidationError(`${label} contains unsupported characters.`);
  }
  return value;
}

export function boundedDigest(value: unknown, label: string): string {
  const candidate = boundedString(value, label, MAX_DIGEST_LENGTH);
  if (!/^[a-z0-9_.:-]+$/.test(candidate)) {
    throw new OrganizationValidationError(`${label} must be an opaque digest.`);
  }
  return candidate;
}

export function opaqueReference(value: unknown, label: string): string {
  const candidate = boundedString(value, label, MAX_STRING_LENGTH);
  if (!/^[a-z][a-z0-9_-]*$/.test(candidate)) {
    throw new OrganizationValidationError(`${label} must be an opaque reference.`);
  }
  return candidate;
}

export function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new OrganizationValidationError(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value as number;
}

export function parseScope(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ARRAY_LENGTH) {
    throw new OrganizationValidationError('scope must contain 1 to 32 entries.');
  }
  const scope = value.map((entry, index) => {
    const candidate = boundedString(entry, `scope[${index}]`, 120);
    if (candidate.startsWith('/') || !/^[A-Za-z0-9._:-]+(?:\/[A-Za-z0-9._:-]+)*$/.test(candidate) || candidate.includes('..')) {
      throw new OrganizationValidationError(`scope[${index}] is not a bounded scope token.`);
    }
    return candidate;
  });
  if (new Set(scope).size !== scope.length) {
    throw new OrganizationValidationError('scope must not contain duplicates.');
  }
  return Object.freeze(scope);
}

export function parseCapabilities(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_ARRAY_LENGTH) {
    throw new OrganizationValidationError('capabilities must contain at most 32 entries.');
  }
  const capabilities = value.map((entry, index) => {
    const candidate = boundedString(entry, `capabilities[${index}]`, 120);
    if (!/^cap_[a-z0-9][a-z0-9_-]{2,80}$/.test(candidate)) {
      throw new OrganizationValidationError(`capabilities[${index}] is not a bounded capability token.`);
    }
    return candidate;
  });
  if (new Set(capabilities).size !== capabilities.length) {
    throw new OrganizationValidationError('capabilities must not contain duplicates.');
  }
  return Object.freeze([...capabilities].sort());
}

export function parseModel(value: unknown): OrganizationModelReference {
  if (!isRecord(value)) throw new OrganizationValidationError('model must be an object.');
  assertExactKeys(value, ['providerId', 'modelId'], 'model');
  return Object.freeze({
    providerId: boundedString(value.providerId, 'model.providerId', 80),
    modelId: boundedString(value.modelId, 'model.modelId', 120),
  });
}

