import { createHash } from 'node:crypto';
import {
  OrganizationValidationError,
  parseOrganizationAction,
  type CreateAgentAction,
  type OrganizationModelReference,
} from './organization-contract.js';

export const ORGANIZATION_AGENT_PROJECTION_VERSION = 1;

export interface DynamicAgentProfileProposal {
  readonly version: typeof ORGANIZATION_AGENT_PROJECTION_VERSION;
  readonly id: string;
  readonly organizationAgentId: string;
  readonly displayName: string;
  readonly instructionsDigest: string;
  readonly model: OrganizationModelReference;
  readonly projectId: string;
  readonly delegationId: string;
  readonly parentDelegationId: string | null;
  readonly scope: readonly string[];
  readonly capabilities: readonly string[];
  readonly maxDelegationDepth: number;
  readonly ttlEvents: number;
}

const secretLike = /(secret|password|passwd|token|api[_-]?key|credential|plaintext|private[_-]?key|Bearer|sk-|ghp_|github_pat_)/i;

function assertBoundedProposal(action: CreateAgentAction): void {
  const serialized = JSON.stringify(action);
  if (secretLike.test(serialized)) {
    throw new OrganizationValidationError('Dynamic Agent proposal contains secret-like content.');
  }
  if (/[\\/]|[a-z]+:\/\//i.test(serialized)) {
    throw new OrganizationValidationError('Dynamic Agent proposal must not contain paths or URLs.');
  }
}

function projectionId(action: CreateAgentAction): string {
  return `dagp_${createHash('sha256').update(JSON.stringify({
    projectId: action.projectId,
    workerId: action.workerId,
    delegationId: action.delegationId,
    agentRevisionId: action.agentRevisionId,
    instructionsDigest: action.instructionsDigest,
    model: action.model,
  })).digest('hex').slice(0, 24)}`;
}

export function projectDynamicAgentProposal(input: unknown): DynamicAgentProfileProposal {
  const action = parseOrganizationAction(input);
  if (action.type !== 'create_agent') {
    throw new OrganizationValidationError('Dynamic Agent projection requires create_agent.');
  }
  assertBoundedProposal(action);
  return Object.freeze({
    version: ORGANIZATION_AGENT_PROJECTION_VERSION,
    id: projectionId(action),
    organizationAgentId: action.workerId,
    displayName: action.displayName,
    instructionsDigest: action.instructionsDigest,
    model: action.model,
    projectId: action.projectId,
    delegationId: action.delegationId,
    parentDelegationId: action.parentDelegationId ?? null,
    scope: action.scope,
    capabilities: action.capabilities,
    maxDelegationDepth: action.maxDelegationDepth,
    ttlEvents: action.ttlEvents,
  });
}
