import type { ModelAdapter, ModelTurn } from '../../src/runtime/model-adapter.js';
import type { ToolApprovalSource } from '../../src/runtime/task-runner.js';

export const FAKE_SECRET_MARKER = 'fixture-secret-never-logged';

interface HealthResponseFixture {
  readonly status: 'ok';
  readonly service: 'conchbase';
  readonly apiVersion: 1;
}

interface RuntimeResponseFixture {
  readonly name: 'Conchbase';
  readonly version: string;
  readonly state: 'ready';
  readonly capabilities: readonly string[];
  readonly organizationContract?: '1.1.0';
  readonly organizationPaths?: 18;
  readonly executionContract?: '1.2.0';
  readonly executionPaths?: 8;
}

export const ORGANIZATION_PATHS_FIXTURE = Object.freeze([
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

export const EXECUTION_PATHS_FIXTURE = Object.freeze([
  '/v1/execution/health',
  '/v1/execution/capabilities',
  '/v1/execution/grants',
  '/v1/execution/grants/{grantId}/revoke',
  '/v1/execution/requests',
  '/v1/execution/requests/{requestId}',
  '/v1/execution/requests/{requestId}/decide',
  '/v1/execution/events',
] as const);

export const HEALTH_RESPONSE_FIXTURE: HealthResponseFixture = Object.freeze({
  status: 'ok',
  service: 'conchbase',
  apiVersion: 1,
});

export const RUNTIME_RESPONSE_FIXTURE: RuntimeResponseFixture = Object.freeze({
  name: 'Conchbase',
  version: '1.0.0',
  state: 'ready',
  capabilities: Object.freeze([] as string[]),
});

export const READ_ONLY_TOOL_CALL: ModelTurn = Object.freeze({
  kind: 'tool_call',
  toolName: 'read_file',
  output: FAKE_SECRET_MARKER,
});

export const DENIED_TOOL_CALL: ModelTurn = Object.freeze({
  kind: 'tool_call',
  toolName: 'delete_file',
  output: 'denied',
});

export const FINAL_TURN: ModelTurn = Object.freeze({
  kind: 'final',
  output: 'done',
});

export function mutableApprovalSource(
  approvedToolNames: readonly string[],
): ToolApprovalSource & { revoke(toolName: string): void; grant(toolName: string): void } {
  const approved = new Set(approvedToolNames);

  return {
    isApproved(toolName: string): boolean {
      return approved.has(toolName);
    },
    revoke(toolName: string): void {
      approved.delete(toolName);
    },
    grant(toolName: string): void {
      approved.add(toolName);
    },
  };
}

export function scriptedModelAdapter(turns: readonly ModelTurn[]): ModelAdapter {
  const remaining = [...turns];

  return {
    async nextTurn(): Promise<ModelTurn> {
      const turn = remaining.shift();
      if (!turn) throw new Error('Scripted model adapter has no remaining turn.');
      return turn;
    },
  };
}
