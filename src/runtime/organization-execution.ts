import {
  ORGANIZATION_CONTRACT_VERSION,
  type OrganizationEvent,
  type OrganizationSnapshot,
} from './organization-contract.js';

export const ORGANIZATION_EXECUTION_CONTRACT_VERSION = 1;

const DEFAULT_GLOBAL_LIMIT = 8;
const DEFAULT_PROJECT_LIMIT = 2;
const MAX_LIMIT = 32;

export type OrganizationCommandType =
  | 'start_work'
  | 'stop_work'
  | 'complete_work'
  | 'reconcile_assignment';

export interface OrganizationCommand {
  readonly type: OrganizationCommandType;
  readonly workItemId: string;
  readonly expectedState: 'open' | 'paused' | 'running';
  readonly assignmentId?: string;
  readonly outcome?: 'succeeded' | 'failed';
}

export interface OrganizationRelay {
  readonly sequence: number;
  readonly projectId: string;
  readonly kind: 'result' | 'attention' | 'blocked' | 'failed';
  readonly digest: string;
}

export interface OrganizationExecutionPlan {
  readonly version: typeof ORGANIZATION_EXECUTION_CONTRACT_VERSION;
  readonly commands: readonly OrganizationCommand[];
  readonly relays: readonly OrganizationRelay[];
  readonly activeWorkItemIds: readonly string[];
}

export interface WorkStateView {
  readonly id: string;
  readonly state: 'open' | 'running' | 'paused' | 'completed' | 'cancelled';
  readonly assignmentIds: readonly string[];
  readonly interruptedAssignmentIds: readonly string[];
}

export interface OrganizationExecutionLimits {
  readonly globalActive: number;
  readonly perProjectActive: number;
}

const RELAY_EVENT_TYPES = new Map<string, OrganizationRelay['kind']>([
  ['organization.report_recorded', 'result'],
  ['organization.attention_requested', 'attention'],
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scalar(value: unknown, key: string): string {
  return isRecord(value) && typeof value[key] === 'string' ? value[key] : '';
}

function relayKind(event: OrganizationEvent): OrganizationRelay['kind'] | undefined {
  const mapped = RELAY_EVENT_TYPES.get(event.type);
  if (mapped === 'result') {
    const state = scalar(event.data, 'reportState');
    if (state === 'ready') return 'result';
    if (state === 'attention') return 'attention';
    if (state === 'blocked') return 'blocked';
    if (state === 'failed') return 'failed';
    return undefined;
  }
  return mapped;
}

function parseLimits(limits: OrganizationExecutionLimits | undefined): OrganizationExecutionLimits {
  const globalActive = limits?.globalActive ?? DEFAULT_GLOBAL_LIMIT;
  const perProjectActive = limits?.perProjectActive ?? DEFAULT_PROJECT_LIMIT;
  for (const value of [globalActive, perProjectActive]) {
    if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
      throw new RangeError(`Organization execution limit must be an integer from 1 to ${MAX_LIMIT}.`);
    }
  }
  return Object.freeze({ globalActive, perProjectActive });
}

function buildRelays(events: readonly OrganizationEvent[]): readonly OrganizationRelay[] {
  const relays: OrganizationRelay[] = [];
  for (const event of events) {
    const kind = relayKind(event);
    if (!kind) continue;
    const digest = scalar(event.data, 'summaryDigest')
      || scalar(event.data, 'questionDigest')
      || scalar(event.data, 'decisionDigest');
    if (!digest) continue;
    relays.push(Object.freeze({
      sequence: event.sequence,
      projectId: event.projectId,
      kind,
      digest,
    }));
  }
  return Object.freeze(relays);
}

function buildCommands(
  snapshot: OrganizationSnapshot,
  work: readonly WorkStateView[],
  limits: OrganizationExecutionLimits,
): {
  readonly commands: readonly OrganizationCommand[];
  readonly activeWorkItemIds: readonly string[];
} {
  const commands: OrganizationCommand[] = [];
  const activeWorkItemIds: string[] = [];
  const activeByProject = new Map<string, number>();
  for (const item of work) {
    if (item.state !== 'running') continue;
    activeWorkItemIds.push(item.id);
    for (const assignmentId of item.interruptedAssignmentIds) {
      commands.push(Object.freeze({
        type: 'reconcile_assignment',
        workItemId: item.id,
        assignmentId,
        expectedState: 'running',
        outcome: 'failed' as const,
      }));
    }
    const projectId = snapshot.projects.find((project) => project.id === item.id)?.id
      ?? snapshot.projects.find((project) => item.id.includes(project.id))?.id;
    if (projectId) activeByProject.set(projectId, (activeByProject.get(projectId) ?? 0) + 1);
  }

  if (snapshot.attentionRequests.some((request) => request.state === 'open')) {
    return Object.freeze({
      commands: Object.freeze(commands),
      activeWorkItemIds: Object.freeze(activeWorkItemIds),
    });
  }

  for (const worker of snapshot.workers) {
    if (worker.state !== 'authorized' && worker.state !== 'idle' && worker.state !== 'running') continue;
    const project = snapshot.projects.find((candidate) => candidate.id === worker.projectId);
    if (!project || project.state !== 'active' && project.state !== 'resumed') continue;
    if (snapshot.delegations.find((delegation) => delegation.id === worker.delegationId)?.state !== 'active') continue;
    if (activeWorkItemIds.length >= limits.globalActive) break;
    if ((activeByProject.get(worker.projectId) ?? 0) >= limits.perProjectActive) continue;
    const executionEvent = [...snapshot.events].reverse().find((event) =>
      event.type === 'organization.worker_execution_recorded' && event.data.workerId === worker.id);
    const workItemId = typeof executionEvent?.data.workItemId === 'string'
      ? executionEvent.data.workItemId
      : `work_${worker.id}`;
    if (work.some((item) => item.id === workItemId)) continue;
    commands.push(Object.freeze({
      type: 'start_work',
      workItemId,
      expectedState: 'open',
    }));
    activeWorkItemIds.push(workItemId);
    activeByProject.set(worker.projectId, (activeByProject.get(worker.projectId) ?? 0) + 1);
  }
  return Object.freeze({
    commands: Object.freeze(commands),
    activeWorkItemIds: Object.freeze(activeWorkItemIds),
  });
}

export function planOrganizationExecution(
  snapshot: OrganizationSnapshot,
  work: readonly WorkStateView[],
  limits?: OrganizationExecutionLimits,
): OrganizationExecutionPlan {
  if (snapshot.version !== ORGANIZATION_CONTRACT_VERSION) {
    throw new Error('Unsupported organization snapshot version.');
  }
  const parsedLimits = parseLimits(limits);
  const { commands, activeWorkItemIds } = buildCommands(snapshot, work, parsedLimits);
  return Object.freeze({
    version: ORGANIZATION_EXECUTION_CONTRACT_VERSION,
    commands,
    relays: buildRelays(snapshot.events),
    activeWorkItemIds,
  });
}
