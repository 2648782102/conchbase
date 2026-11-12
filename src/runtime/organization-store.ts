import {
  ORGANIZATION_CONTRACT_VERSION,
  OrganizationConflictError,
  OrganizationValidationError,
  applyOrganizationAction,
  createOrganization,
  parseOrganizationAction,
  type OrganizationAction,
  type OrganizationEvent,
  type OrganizationSnapshot,
} from './organization-contract.js';

export interface OrganizationStore {
  initialize(conversationId: string): OrganizationSnapshot;
  get(): OrganizationSnapshot;
  apply(input: unknown): OrganizationSnapshot;
  events(limit?: number): readonly OrganizationEvent[];
}

export function parseOrganizationLimit(value: number | undefined): number {
  if (value === undefined) return 100;
  if (!Number.isInteger(value) || value < 1 || value > 1000) {
    throw new OrganizationValidationError('Event limit must be an integer from 1 to 1000.');
  }
  return value;
}

export class InMemoryOrganizationStore implements OrganizationStore {
  private snapshot: OrganizationSnapshot | undefined;

  constructor(conversationId = 'primary_conversation') {
    this.snapshot = createOrganization(conversationId);
  }

  initialize(conversationId: string): OrganizationSnapshot {
    const candidate = conversationId.trim();
    if (candidate.length === 0 || candidate.length > 240) {
      throw new OrganizationValidationError('Conversation id must be a bounded non-empty string.');
    }
    this.snapshot = createOrganization(candidate);
    return this.snapshot;
  }

  get(): OrganizationSnapshot {
    if (!this.snapshot) throw new OrganizationConflictError('Organization store is not initialized.');
    return this.snapshot;
  }

  apply(input: unknown): OrganizationSnapshot {
    const parsed: OrganizationAction = parseOrganizationAction(input);
    this.snapshot = applyOrganizationAction(this.get(), parsed);
    return this.snapshot;
  }

  events(limit?: number): readonly OrganizationEvent[] {
    const events = this.get().events;
    const bounded = parseOrganizationLimit(limit);
    return Object.freeze(events.slice(-bounded));
  }
}

export const ORGANIZATION_STORE_CONTRACT_VERSION = ORGANIZATION_CONTRACT_VERSION;
