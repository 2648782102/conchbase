export const ORGANIZATION_PUBLIC_CONTRACT_VERSION = '1.1.0';

export const ORGANIZATION_PUBLIC_PATHS = Object.freeze([
  '/v1/organization/session',
  '/v1/organization/session/intents',
  '/v1/organization/projects',
  '/v1/organization/projects/{projectId}',
  '/v1/organization/projects/{projectId}/threads',
  '/v1/organization/agents/proposals',
  '/v1/organization/agents/proposals/{proposalId}',
  '/v1/organization/delegations',
  '/v1/organization/delegations/{delegationId}',
  '/v1/organization/work-items',
  '/v1/organization/work-items/{workItemId}',
  '/v1/organization/reports',
  '/v1/organization/reports/{reportId}',
  '/v1/organization/attention',
  '/v1/organization/attention/{attentionId}',
  '/v1/organization/attention/{attentionId}/answer',
  '/v1/organization/attention/{attentionId}/withdraw',
  '/v1/organization/events',
] as const);

export const ORGANIZATION_PUBLIC_PATH_COUNT = ORGANIZATION_PUBLIC_PATHS.length;
