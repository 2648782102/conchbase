import { randomUUID } from 'node:crypto';

export type AgentId = string & { readonly __brand: 'AgentId' };
export type AgentRevisionId = string & { readonly __brand: 'AgentRevisionId' };

export interface ModelReference {
  readonly providerId: string;
  readonly modelId: string;
}

export interface AgentProfileInput extends ModelReference {
  readonly name: string;
  readonly instructions: string;
}

export interface AgentRevision extends AgentProfileInput {
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
  });
}

export function newAgentId(): AgentId {
  return `agt_${randomUUID().replaceAll('-', '')}` as AgentId;
}

export function newAgentRevision(profile: AgentProfileInput, createdAt: string): AgentRevision {
  const id = `agr_${randomUUID().replaceAll('-', '')}` as AgentRevisionId;
  return Object.freeze({ ...profile, id, createdAt });
}

