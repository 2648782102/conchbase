import { randomUUID } from 'node:crypto';

export type AgentId = string & { readonly __brand: 'AgentId' };
export type AgentRevisionId = string & { readonly __brand: 'AgentRevisionId' };

export interface ModelReference {
  readonly providerId: string;
  readonly modelId: string;
}

export const CAPABILITY_GRANT_KINDS = Object.freeze(['tool', 'skill'] as const);
export type CapabilityGrantKind = typeof CAPABILITY_GRANT_KINDS[number];

export interface CapabilityGrant {
  readonly kind: CapabilityGrantKind;
  readonly name: string;
}

export interface AgentProfileInput extends ModelReference {
  readonly name: string;
  readonly instructions: string;
  /** Omitted means "no capabilities"; callers never inherit Runtime-wide grants. */
  readonly grantedCapabilities?: readonly CapabilityGrant[];
}

export interface AgentRevision extends Omit<AgentProfileInput, 'grantedCapabilities'> {
  readonly grantedCapabilities: readonly CapabilityGrant[];
  readonly id: AgentRevisionId;
  readonly createdAt: string;
}

export interface AgentRecord {
  readonly id: AgentId;
  readonly currentRevisionId: AgentRevisionId;
  readonly archived: boolean;
  readonly isDefault: boolean;
  readonly current: AgentRevision;
}

export interface AgentDetail extends AgentRecord {
  readonly revisions: readonly AgentRevision[];
}

export class AgentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentValidationError';
  }
}

export class AgentNotFoundError extends Error {
  constructor() {
    super('Agent not found.');
    this.name = 'AgentNotFoundError';
  }
}

export class AgentConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentConflictError';
  }
}

export function parseAgentProfile(input: unknown): AgentProfileInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new AgentValidationError('Agent profile must be an object.');
  }
  const value = input as Record<string, unknown>;
  if (typeof value.name !== 'string' || value.name.trim().length === 0 || value.name.length > 120) {
    throw new AgentValidationError('name must be a non-empty string of at most 120 characters.');
  }
  if (typeof value.instructions !== 'string' || value.instructions.length > 20_000) {
    throw new AgentValidationError('instructions must be a string of at most 20000 characters.');
  }
  if (typeof value.providerId !== 'string'
    || !/^[a-z][a-z0-9-]{0,63}$/.test(value.providerId)) {
    throw new AgentValidationError('providerId must be a lowercase provider identifier.');
  }
  if (typeof value.modelId !== 'string' || value.modelId.trim().length === 0 || value.modelId.length > 300) {
    throw new AgentValidationError('modelId must be a non-empty string of at most 300 characters.');
  }
  return Object.freeze({
    name: value.name.trim(),
    instructions: value.instructions,
    providerId: value.providerId,
    modelId: value.modelId,
    grantedCapabilities: parseCapabilityGrants(value.grantedCapabilities),
  });
}

const MAX_CAPABILITY_GRANTS = 64;
const CAPABILITY_NAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,119}$/;

export function parseCapabilityGrants(input: unknown): readonly CapabilityGrant[] {
  if (input === undefined) return Object.freeze([]);
  if (!Array.isArray(input)) {
    throw new AgentValidationError('grantedCapabilities must be an array.');
  }
  if (input.length > MAX_CAPABILITY_GRANTS) {
    throw new AgentValidationError(`grantedCapabilities must contain at most ${MAX_CAPABILITY_GRANTS} entries.`);
  }
  const seen = new Set<string>();
  const grants: CapabilityGrant[] = [];
  for (const [index, entry] of input.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new AgentValidationError(`grantedCapabilities[${index}] must be an object.`);
    }
    const value = entry as Record<string, unknown>;
    for (const key of Object.keys(value)) {
      if (key !== 'kind' && key !== 'name') {
        throw new AgentValidationError(`grantedCapabilities[${index}] has unknown field '${key}'.`);
      }
    }
    if (typeof value.kind !== 'string' || !CAPABILITY_GRANT_KINDS.includes(value.kind as CapabilityGrantKind)) {
      throw new AgentValidationError(`grantedCapabilities[${index}].kind must be tool or skill.`);
    }
    if (typeof value.name !== 'string' || !CAPABILITY_NAME_PATTERN.test(value.name)) {
      throw new AgentValidationError(`grantedCapabilities[${index}].name is not a bounded capability name.`);
    }
    const key = `${value.kind}:${value.name}`;
    if (seen.has(key)) {
      throw new AgentValidationError(`grantedCapabilities contains a duplicate '${key}'.`);
    }
    seen.add(key);
    grants.push(Object.freeze({ kind: value.kind as CapabilityGrantKind, name: value.name }));
  }
  grants.sort((left, right) => (left.kind === right.kind
    ? left.name.localeCompare(right.name)
    : left.kind.localeCompare(right.kind)));
  return Object.freeze(grants);
}

export function newAgentId(): AgentId {
  return `agt_${randomUUID().replaceAll('-', '')}` as AgentId;
}

export function newAgentRevision(profile: AgentProfileInput, createdAt: string): AgentRevision {
  const id = `agr_${randomUUID().replaceAll('-', '')}` as AgentRevisionId;
  return Object.freeze({
    ...profile,
    grantedCapabilities: Object.freeze([...(profile.grantedCapabilities ?? [])]),
    id,
    createdAt,
  });
}

