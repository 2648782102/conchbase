import { createHash } from 'node:crypto';

export const ORGANIZATION_CONTRACT_VERSION = 1;

const MAX_DELEGATION_DEPTH = 3;
const MAX_TTL_EVENTS = 1000;
const MAX_ARRAY_LENGTH = 32;
const MAX_STRING_LENGTH = 240;
const MAX_DIGEST_LENGTH = 128;

export type ProjectState = 'forming' | 'active' | 'quiet' | 'archived' | 'stopped' | 'resumed';
export type WorkerState =
  | 'proposed'
  | 'authorized'
  | 'running'
  | 'idle'
  | 'reporting'
  | 'blocked'
  | 'offboarded'
  | 'ended';
export type ReportState =
  | 'draft'
  | 'progress'
  | 'waiting'
  | 'ready'
  | 'blocked'
  | 'failed'
  | 'attention'
  | 'ended';
export type AttentionState = 'open' | 'answered' | 'withdrawn' | 'expired';
export type DelegationState = 'active' | 'revoked';

export interface OrganizationModelReference {
  readonly providerId: string;
  readonly modelId: string;
}

export interface BossSession {
  readonly version: typeof ORGANIZATION_CONTRACT_VERSION;
  readonly id: string;
  readonly state: 'active';
  readonly projectIds: readonly string[];
}

export interface Project {
  readonly version: typeof ORGANIZATION_CONTRACT_VERSION;
  readonly id: string;
  readonly bossSessionId: string;
  readonly originTriggerId: string;
  readonly state: ProjectState;
}

export interface Delegation {
  readonly version: typeof ORGANIZATION_CONTRACT_VERSION;
  readonly id: string;
  readonly projectId: string;
  readonly parentDelegationId: string | null;
  readonly workerId: string;
  readonly scope: readonly string[];
  readonly capabilities: readonly string[];
  readonly maxDelegationDepth: number;
  readonly expiresAtSequence: number;
  readonly authorizationDigest: string;
  readonly state: DelegationState;
}

export interface OrganizationWorker {
  readonly version: typeof ORGANIZATION_CONTRACT_VERSION;
  readonly id: string;
  readonly projectId: string;
  readonly delegationId: string;
  readonly agentRevisionId: string;
  readonly displayName: string;
  readonly instructionsDigest: string;
  readonly model: OrganizationModelReference;
  readonly state: WorkerState;
}

export interface OrganizationReport {
  readonly version: typeof ORGANIZATION_CONTRACT_VERSION;
  readonly id: string;
  readonly projectId: string;
  readonly workerId: string;
  readonly state: ReportState;
  readonly summaryDigest: string;
  readonly sequence: number;
}

export interface AttentionRequest {
  readonly version: typeof ORGANIZATION_CONTRACT_VERSION;
  readonly id: string;
  readonly projectId: string;
  readonly workerId: string;
  readonly state: AttentionState;
  readonly questionDigest: string;
  readonly sequence: number;
}

export interface OrganizationEvent {
  readonly version: typeof ORGANIZATION_CONTRACT_VERSION;
  readonly id: string;
  readonly sequence: number;
  readonly type: string;
  readonly projectId: string;
  readonly data: Readonly<Record<string, string | number | boolean>>;
}

export interface OrganizationSnapshot {
  readonly version: typeof ORGANIZATION_CONTRACT_VERSION;
  readonly bossSession: BossSession;
  readonly projects: readonly Project[];
  readonly delegations: readonly Delegation[];
  readonly workers: readonly OrganizationWorker[];
  readonly reports: readonly OrganizationReport[];
  readonly attentionRequests: readonly AttentionRequest[];
  readonly events: readonly OrganizationEvent[];
}

interface OrganizationActionBase<Type extends string = string> {
  readonly type: Type;
  readonly expectedSequence: number;
  readonly projectId: string;
}

export interface OpenProjectAction extends OrganizationActionBase<'open_project'> {
  readonly originTriggerId: string;
}

export interface RecordIntentAction extends OrganizationActionBase<'record_intent'> {
  readonly intentId: string;
  readonly bodyDigest: string;
  readonly actionCount: number;
}

export interface CreateAgentAction extends OrganizationActionBase<'create_agent'> {
  readonly workerId: string;
  readonly delegationId: string;
  readonly parentDelegationId?: string;
  readonly agentRevisionId: string;
  readonly displayName: string;
  readonly instructionsDigest: string;
  readonly scope: readonly string[];
  readonly capabilities: readonly string[];
  readonly model: OrganizationModelReference;
  readonly maxDelegationDepth: number;
  readonly ttlEvents: number;
}

export interface AuthorizeWorkerAction extends OrganizationActionBase<'authorize_worker'> {
  readonly workerId: string;
}

export interface StartWorkerAction extends OrganizationActionBase<'start_worker'> {
  readonly workerId: string;
}

export interface ReportWorkerAction extends OrganizationActionBase<'report_worker'> {
  readonly workerId: string;
  readonly reportId: string;
  readonly state: ReportState;
  readonly summaryDigest: string;
}

export interface RequestAttentionAction extends OrganizationActionBase<'request_attention'> {
  readonly workerId: string;
  readonly attentionId: string;
  readonly questionDigest: string;
}

export interface AttentionDecisionAction extends OrganizationActionBase<'answer_attention' | 'withdraw_attention' | 'expire_attention'> {
  readonly attentionId: string;
  readonly decisionDigest: string;
}

export interface ProjectLifecycleAction extends OrganizationActionBase<'quiet_project' | 'archive_project' | 'resume_project'> {
  readonly type: 'quiet_project' | 'archive_project' | 'resume_project';
  readonly revalidatedDelegationId?: string;
}

export interface ActivateProjectAction extends OrganizationActionBase<'activate_project'> {}

export interface OffboardWorkerAction extends OrganizationActionBase<'offboard_worker'> {
  readonly workerId: string;
}

export interface ActivateDelegationAction extends OrganizationActionBase<'activate_delegation'> {
  readonly delegationId: string;
}

export interface RecordWorkerExecutionAction extends OrganizationActionBase<'record_worker_execution'> {
  readonly workerId: string;
  readonly taskId: string;
  readonly workItemId: string;
  readonly agentId: string;
}

export interface ResumeWorkerAction extends OrganizationActionBase<'resume_worker'> {
  readonly workerId: string;
}

export type OrganizationAction =
  | OpenProjectAction
  | RecordIntentAction
  | CreateAgentAction
  | AuthorizeWorkerAction
  | StartWorkerAction
  | ReportWorkerAction
  | RequestAttentionAction
  | AttentionDecisionAction
  | ProjectLifecycleAction
  | ActivateProjectAction
  | OffboardWorkerAction
  | ActivateDelegationAction
  | RecordWorkerExecutionAction
  | ResumeWorkerAction;

export class OrganizationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrganizationValidationError';
  }
}

export class OrganizationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrganizationConflictError';
  }
}

export class OrganizationNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrganizationNotFoundError';
  }
}

const REPORT_STATES: readonly ReportState[] = Object.freeze([
  'draft',
  'progress',
  'waiting',
  'ready',
  'blocked',
  'failed',
  'attention',
  'ended',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  const canonical: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) canonical[key] = canonicalize(value[key]);
  return canonical;
}

function digest(kind: string, value: unknown): string {
  return createHash('sha256')
    .update(`${kind}:${JSON.stringify(canonicalize(value))}`)
    .digest('hex');
}

function opaqueId(kind: string, value: unknown): string {
  return `${kind}_${digest(kind, value).slice(0, 24)}`;
}

function assertExactKeys(
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

function rejectSecretLike(value: unknown, path = 'action', depth = 0): void {
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

function boundedString(value: unknown, label: string, max = MAX_STRING_LENGTH): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new OrganizationValidationError(`${label} must be a non-empty string of at most ${max} characters.`);
  }
  if (value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new OrganizationValidationError(`${label} contains unsupported characters.`);
  }
  return value;
}

function boundedDigest(value: unknown, label: string): string {
  const candidate = boundedString(value, label, MAX_DIGEST_LENGTH);
  if (!/^[a-z0-9_.:-]+$/.test(candidate)) {
    throw new OrganizationValidationError(`${label} must be an opaque digest.`);
  }
  return candidate;
}

function opaqueReference(value: unknown, label: string): string {
  const candidate = boundedString(value, label, MAX_STRING_LENGTH);
  if (!/^[a-z][a-z0-9_-]*$/.test(candidate)) {
    throw new OrganizationValidationError(`${label} must be an opaque reference.`);
  }
  return candidate;
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new OrganizationValidationError(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value as number;
}

function parseScope(value: unknown): readonly string[] {
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

function parseCapabilities(value: unknown): readonly string[] {
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

function parseModel(value: unknown): OrganizationModelReference {
  if (!isRecord(value)) throw new OrganizationValidationError('model must be an object.');
  assertExactKeys(value, ['providerId', 'modelId'], 'model');
  return Object.freeze({
    providerId: boundedString(value.providerId, 'model.providerId', 80),
    modelId: boundedString(value.modelId, 'model.modelId', 120),
  });
}

function parseCommonAction<Type extends string>(
  value: Record<string, unknown>,
  type: Type,
): OrganizationActionBase & { readonly type: Type } {
  return Object.freeze({
    type,
    expectedSequence: boundedInteger(value.expectedSequence, 'expectedSequence', 0, Number.MAX_SAFE_INTEGER),
    projectId: opaqueReference(value.projectId, 'projectId'),
  });
}

export function parseOrganizationAction(input: unknown): OrganizationAction {
  rejectSecretLike(input);
  if (!isRecord(input)) throw new OrganizationValidationError('Organization action must be an object.');
  const actionType = input.type;
  if (typeof actionType !== 'string') throw new OrganizationValidationError('Action type must be a string.');

  if (actionType === 'activate_project') {
    assertExactKeys(input, ['type', 'expectedSequence', 'projectId'], actionType);
    return Object.freeze(parseCommonAction(input, actionType));
  }

  switch (actionType) {
    case 'open_project': {
      assertExactKeys(input, ['type', 'expectedSequence', 'projectId', 'originTriggerId'], 'open_project');
      const common = parseCommonAction(input, actionType);
      return Object.freeze({ ...common, originTriggerId: opaqueReference(input.originTriggerId, 'originTriggerId') });
    }
    case 'record_intent': {
      assertExactKeys(input, ['type', 'expectedSequence', 'projectId', 'intentId', 'bodyDigest', 'actionCount'], actionType);
      const common = parseCommonAction(input, actionType);
      return Object.freeze({
        ...common,
        intentId: opaqueReference(input.intentId, 'intentId'),
        bodyDigest: boundedDigest(input.bodyDigest, 'bodyDigest'),
        actionCount: boundedInteger(input.actionCount, 'actionCount', 0, 32),
      });
    }
    case 'activate_delegation': {
      assertExactKeys(input, ['type', 'expectedSequence', 'projectId', 'delegationId'], actionType);
      const common = parseCommonAction(input, actionType);
      return Object.freeze({ ...common, delegationId: opaqueReference(input.delegationId, 'delegationId') });
    }
    case 'record_worker_execution': {
      assertExactKeys(
        input,
        ['type', 'expectedSequence', 'projectId', 'workerId', 'taskId', 'workItemId', 'agentId'],
        actionType,
      );
      const common = parseCommonAction(input, actionType);
      return Object.freeze({
        ...common,
        workerId: opaqueReference(input.workerId, 'workerId'),
        taskId: opaqueReference(input.taskId, 'taskId'),
        workItemId: opaqueReference(input.workItemId, 'workItemId'),
        agentId: opaqueReference(input.agentId, 'agentId'),
      });
    }
    case 'resume_worker': {
      assertExactKeys(input, ['type', 'expectedSequence', 'projectId', 'workerId'], actionType);
      const common = parseCommonAction(input, actionType);
      return Object.freeze({ ...common, workerId: opaqueReference(input.workerId, 'workerId') });
    }
    case 'create_agent': {
      assertExactKeys(
        input,
        [
          'type',
          'expectedSequence',
          'projectId',
          'workerId',
          'delegationId',
          'agentRevisionId',
          'displayName',
          'instructionsDigest',
          'scope',
          'capabilities',
          'model',
          'maxDelegationDepth',
          'ttlEvents',
        ],
        'create_agent',
        ['parentDelegationId'],
      );
      const parentDelegationId =
        input.parentDelegationId === undefined
          ? undefined
          : opaqueReference(input.parentDelegationId, 'parentDelegationId');
      const common = parseCommonAction(input, actionType);
      return Object.freeze({
        ...common,
        workerId: opaqueReference(input.workerId, 'workerId'),
        delegationId: opaqueReference(input.delegationId, 'delegationId'),
        ...(parentDelegationId === undefined ? {} : { parentDelegationId }),
        agentRevisionId: opaqueReference(input.agentRevisionId, 'agentRevisionId'),
        displayName: boundedString(input.displayName, 'displayName', 80),
        instructionsDigest: boundedDigest(input.instructionsDigest, 'instructionsDigest'),
        scope: parseScope(input.scope),
        capabilities: parseCapabilities(input.capabilities),
        model: parseModel(input.model),
        maxDelegationDepth: boundedInteger(input.maxDelegationDepth, 'maxDelegationDepth', 0, MAX_DELEGATION_DEPTH),
        ttlEvents: boundedInteger(input.ttlEvents, 'ttlEvents', 1, MAX_TTL_EVENTS),
      });
    }
    case 'authorize_worker':
    case 'start_worker':
    case 'offboard_worker': {
      assertExactKeys(input, ['type', 'expectedSequence', 'projectId', 'workerId'], actionType);
      const common = parseCommonAction(input, actionType as 'authorize_worker' | 'start_worker' | 'offboard_worker');
      return Object.freeze({ ...common, workerId: opaqueReference(input.workerId, 'workerId') });
    }
    case 'report_worker': {
      assertExactKeys(
        input,
        ['type', 'expectedSequence', 'projectId', 'workerId', 'reportId', 'state', 'summaryDigest'],
        'report_worker',
      );
      if (!REPORT_STATES.includes(input.state as ReportState)) {
        throw new OrganizationValidationError('report.state is not accepted.');
      }
      const common = parseCommonAction(input, actionType);
      return Object.freeze({
        ...common,
        workerId: opaqueReference(input.workerId, 'workerId'),
        reportId: opaqueReference(input.reportId, 'reportId'),
        state: input.state as ReportState,
        summaryDigest: boundedDigest(input.summaryDigest, 'summaryDigest'),
      });
    }
    case 'request_attention': {
      assertExactKeys(
        input,
        ['type', 'expectedSequence', 'projectId', 'workerId', 'attentionId', 'questionDigest'],
        'request_attention',
      );
      const common = parseCommonAction(input, actionType);
      return Object.freeze({
        ...common,
        workerId: opaqueReference(input.workerId, 'workerId'),
        attentionId: opaqueReference(input.attentionId, 'attentionId'),
        questionDigest: boundedDigest(input.questionDigest, 'questionDigest'),
      });
    }
    case 'answer_attention':
    case 'withdraw_attention':
    case 'expire_attention': {
      assertExactKeys(
        input,
        ['type', 'expectedSequence', 'projectId', 'attentionId', 'decisionDigest'],
        actionType,
      );
      const common = parseCommonAction(
        input,
        actionType as 'answer_attention' | 'withdraw_attention' | 'expire_attention',
      );
      return Object.freeze({
        ...common,
        attentionId: opaqueReference(input.attentionId, 'attentionId'),
        decisionDigest: boundedDigest(input.decisionDigest, 'decisionDigest'),
      });
    }
    case 'quiet_project':
    case 'archive_project': {
      assertExactKeys(input, ['type', 'expectedSequence', 'projectId'], actionType);
      const common = parseCommonAction(input, actionType as 'quiet_project' | 'archive_project');
      return Object.freeze({ ...common });
    }
    case 'resume_project': {
      assertExactKeys(
        input,
        ['type', 'expectedSequence', 'projectId', 'revalidatedDelegationId'],
        'resume_project',
      );
      const common = parseCommonAction(input, actionType);
      return Object.freeze({
        ...common,
        revalidatedDelegationId: opaqueReference(input.revalidatedDelegationId, 'revalidatedDelegationId'),
      });
    }
    default:
      throw new OrganizationValidationError(`Action type ${input.type} is not accepted.`);
  }
}

export function createOrganization(conversationId: string): OrganizationSnapshot {
  const reference = opaqueReference(conversationId, 'conversationId');
  const bossSession = Object.freeze({
    version: ORGANIZATION_CONTRACT_VERSION,
    id: opaqueId('boss', { reference }),
    state: 'active' as const,
    projectIds: Object.freeze([] as readonly string[]),
  });
  return Object.freeze({
    version: ORGANIZATION_CONTRACT_VERSION,
    bossSession,
    projects: Object.freeze([]),
    delegations: Object.freeze([]),
    workers: Object.freeze([]),
    reports: Object.freeze([]),
    attentionRequests: Object.freeze([]),
    events: Object.freeze([]),
  });
}

function lastSequence(snapshot: OrganizationSnapshot): number {
  return snapshot.events.length === 0 ? 0 : snapshot.events[snapshot.events.length - 1]!.sequence;
}

function assertExpectedSequence(snapshot: OrganizationSnapshot, action: OrganizationAction): void {
  if (action.expectedSequence !== lastSequence(snapshot)) {
    throw new OrganizationConflictError(
      `Expected organization sequence ${action.expectedSequence} does not match ${lastSequence(snapshot)}.`,
    );
  }
}

function findProject(snapshot: OrganizationSnapshot, projectId: string): Project {
  const project = snapshot.projects.find((candidate) => candidate.id === projectId);
  if (!project) throw new OrganizationNotFoundError('Organization project not found.');
  return project;
}

function findWorker(snapshot: OrganizationSnapshot, workerId: string): OrganizationWorker {
  const worker = snapshot.workers.find((candidate) => candidate.id === workerId);
  if (!worker) throw new OrganizationNotFoundError('Organization worker not found.');
  return worker;
}

function findDelegation(snapshot: OrganizationSnapshot, delegationId: string): Delegation {
  const delegation = snapshot.delegations.find((candidate) => candidate.id === delegationId);
  if (!delegation) throw new OrganizationNotFoundError('Organization delegation not found.');
  return delegation;
}

function replace<T>(items: readonly T[], id: string, next: T): readonly T[] {
  return Object.freeze(items.map((item) => ((item as { id: string }).id === id ? next : item)));
}

function appendEvent(
  snapshot: OrganizationSnapshot,
  type: string,
  projectId: string,
  data: Readonly<Record<string, string | number | boolean>>,
): readonly OrganizationEvent[] {
  const sequence = lastSequence(snapshot) + 1;
  const event = Object.freeze({
    version: ORGANIZATION_CONTRACT_VERSION,
    id: opaqueId('evt', { sequence, type, projectId, data }),
    sequence,
    type,
    projectId,
    data: Object.freeze({ ...data }),
  });
  return Object.freeze([...snapshot.events, event]);
}

function isSubset(child: readonly string[], parent: readonly string[]): boolean {
  const parentSet = new Set(parent);
  return child.every((entry) => parentSet.has(entry));
}

function workerCanDelegate(worker: OrganizationWorker): boolean {
  return worker.state === 'authorized' || worker.state === 'running' || worker.state === 'idle' || worker.state === 'reporting';
}

function assertProjectWorker(snapshot: OrganizationSnapshot, action: OrganizationActionBase, workerId: string): void {
  const project = findProject(snapshot, action.projectId);
  const worker = findWorker(snapshot, workerId);
  if (worker.projectId !== project.id) throw new OrganizationConflictError('Worker does not belong to the project.');
}

function nextWorkerState(state: ReportState): WorkerState {
  switch (state) {
    case 'progress':
      return 'running';
    case 'ready':
      return 'reporting';
    case 'blocked':
    case 'failed':
    case 'attention':
      return 'blocked';
    case 'ended':
      return 'ended';
    case 'draft':
    case 'waiting':
    default:
      return 'idle';
  }
}

export function applyOrganizationAction(
  snapshot: OrganizationSnapshot,
  input: unknown,
): OrganizationSnapshot {
  const parsed = parseOrganizationAction(input);
  assertExpectedSequence(snapshot, parsed);

  if (parsed.type === 'activate_project') {
    const project = findProject(snapshot, parsed.projectId);
    if (project.state !== 'forming') {
      throw new OrganizationConflictError('Project cannot be activated from its current state.');
    }
    return Object.freeze({
      ...snapshot,
      projects: replace(snapshot.projects, project.id, Object.freeze({ ...project, state: 'active' as const })),
      events: appendEvent(snapshot, 'organization.project_activated', project.id, {
        fromState: project.state,
      }),
    });
  }

  switch (parsed.type) {
    case 'open_project': {
      if (snapshot.projects.some((project) => project.id === parsed.projectId)) {
        throw new OrganizationConflictError('Organization project already exists.');
      }
      const project = Object.freeze({
        version: ORGANIZATION_CONTRACT_VERSION,
        id: parsed.projectId,
        bossSessionId: snapshot.bossSession.id,
        originTriggerId: parsed.originTriggerId,
        state: 'forming' as const,
      });
      const nextSnapshot: OrganizationSnapshot = Object.freeze({
        ...snapshot,
        bossSession: Object.freeze({
          ...snapshot.bossSession,
          projectIds: Object.freeze([...snapshot.bossSession.projectIds, project.id]),
        }),
        projects: Object.freeze([...snapshot.projects, project]),
        events: appendEvent(snapshot, 'organization.project_opened', project.id, {
          originTriggerDigest: digest('origin', parsed.originTriggerId),
        }),
      });
      return nextSnapshot;
    }
    case 'record_intent': {
      return Object.freeze({
        ...snapshot,
        events: appendEvent(snapshot, 'organization.intent_recorded', parsed.projectId, {
          intentId: parsed.intentId,
          bodyDigest: parsed.bodyDigest,
          actionCount: parsed.actionCount,
        }),
      });
    }
    case 'activate_delegation': {
      const delegation = findDelegation(snapshot, parsed.delegationId);
      if (delegation.projectId !== parsed.projectId) {
        throw new OrganizationConflictError('Delegation does not belong to the project.');
      }
      if (delegation.state === 'active') return snapshot;
      if (delegation.state !== 'revoked') {
        throw new OrganizationConflictError('Delegation cannot be reactivated from its current state.');
      }
      return Object.freeze({
        ...snapshot,
        delegations: replace(
          snapshot.delegations,
          delegation.id,
          Object.freeze({ ...delegation, state: 'active' as const }),
        ),
        events: appendEvent(snapshot, 'organization.delegation_revalidated', parsed.projectId, {
          delegationId: delegation.id,
          authorizationDigest: delegation.authorizationDigest,
        }),
      });
    }
    case 'record_worker_execution': {
      assertProjectWorker(snapshot, parsed, parsed.workerId);
      return Object.freeze({
        ...snapshot,
        events: appendEvent(snapshot, 'organization.worker_execution_recorded', parsed.projectId, {
          workerId: parsed.workerId,
          taskId: parsed.taskId,
          workItemId: parsed.workItemId,
          agentId: parsed.agentId,
        }),
      });
    }
    case 'resume_worker': {
      assertProjectWorker(snapshot, parsed, parsed.workerId);
      const worker = findWorker(snapshot, parsed.workerId);
      if (worker.state !== 'offboarded' && worker.state !== 'idle') {
        throw new OrganizationConflictError('Worker cannot resume from its current state.');
      }
      return Object.freeze({
        ...snapshot,
        workers: replace(snapshot.workers, worker.id, Object.freeze({ ...worker, state: 'idle' as const })),
        events: appendEvent(snapshot, 'organization.worker_resumed', parsed.projectId, {
          workerId: worker.id,
        }),
      });
    }
    case 'create_agent': {
      const project = findProject(snapshot, parsed.projectId);
      if (project.state === 'archived' || project.state === 'stopped') {
        throw new OrganizationConflictError('Cannot create an agent for an inactive project.');
      }
      if (snapshot.workers.some((worker) => worker.id === parsed.workerId)) {
        throw new OrganizationConflictError('Organization worker already exists.');
      }
      if (snapshot.delegations.some((delegation) => delegation.id === parsed.delegationId)) {
        throw new OrganizationConflictError('Organization delegation already exists.');
      }

      let parent: Delegation | undefined;
      if (parsed.parentDelegationId !== undefined) {
        parent = findDelegation(snapshot, parsed.parentDelegationId);
        if (parent.projectId !== project.id || parent.state !== 'active') {
          throw new OrganizationConflictError('Parent delegation is not active for this project.');
        }
        if (parent.expiresAtSequence <= lastSequence(snapshot)) {
          throw new OrganizationConflictError('Parent delegation has expired.');
        }
        const parentWorker = findWorker(snapshot, parent.workerId);
        if (!workerCanDelegate(parentWorker)) {
          throw new OrganizationConflictError('Parent worker cannot delegate in its current state.');
        }
        if (!isSubset(parsed.scope, parent.scope) || !isSubset(parsed.capabilities, parent.capabilities)) {
          throw new OrganizationValidationError('Child authority must be a subset of parent authority.');
        }
        if (parsed.maxDelegationDepth > parent.maxDelegationDepth - 1) {
          throw new OrganizationValidationError('Child delegation depth exceeds inherited depth.');
        }
        const remainingEvents = parent.expiresAtSequence - lastSequence(snapshot);
        if (parsed.ttlEvents > remainingEvents) {
          throw new OrganizationValidationError('Child time-to-live exceeds inherited lifetime.');
        }
      }

      const delegation = Object.freeze({
        version: ORGANIZATION_CONTRACT_VERSION,
        id: parsed.delegationId,
        projectId: project.id,
        parentDelegationId: parsed.parentDelegationId ?? null,
        workerId: parsed.workerId,
        scope: parsed.scope,
        capabilities: parsed.capabilities,
        maxDelegationDepth: parsed.maxDelegationDepth,
        expiresAtSequence: lastSequence(snapshot) + parsed.ttlEvents,
        authorizationDigest: digest('authorization', {
          parentDelegationId: parsed.parentDelegationId ?? null,
          scope: parsed.scope,
          capabilities: parsed.capabilities,
          maxDelegationDepth: parsed.maxDelegationDepth,
          ttlEvents: parsed.ttlEvents,
        }),
        state: 'active' as const,
      });
      const worker = Object.freeze({
        version: ORGANIZATION_CONTRACT_VERSION,
        id: parsed.workerId,
        projectId: project.id,
        delegationId: delegation.id,
        agentRevisionId: parsed.agentRevisionId,
        displayName: parsed.displayName,
        instructionsDigest: parsed.instructionsDigest,
        model: parsed.model,
        state: 'proposed' as const,
      });
      return Object.freeze({
        ...snapshot,
        delegations: Object.freeze([...snapshot.delegations, delegation]),
        workers: Object.freeze([...snapshot.workers, worker]),
        events: appendEvent(snapshot, 'organization.agent_proposed', project.id, {
          workerId: worker.id,
          delegationId: delegation.id,
          agentRevisionDigest: digest('agent-revision', parsed.agentRevisionId),
          authorizationDigest: delegation.authorizationDigest,
          maxDelegationDepth: delegation.maxDelegationDepth,
        }),
      });
    }
    case 'authorize_worker': {
      assertProjectWorker(snapshot, parsed, parsed.workerId);
      const worker = findWorker(snapshot, parsed.workerId);
      if (worker.state !== 'proposed') throw new OrganizationConflictError('Worker is not proposed.');
      return Object.freeze({
        ...snapshot,
        workers: replace(snapshot.workers, worker.id, Object.freeze({ ...worker, state: 'authorized' as const })),
        events: appendEvent(snapshot, 'organization.worker_authorized', parsed.projectId, {
          workerId: worker.id,
          delegationId: worker.delegationId,
        }),
      });
    }
    case 'start_worker': {
      assertProjectWorker(snapshot, parsed, parsed.workerId);
      const worker = findWorker(snapshot, parsed.workerId);
      if (worker.state !== 'authorized' && worker.state !== 'idle') {
        throw new OrganizationConflictError('Worker cannot start from its current state.');
      }
      return Object.freeze({
        ...snapshot,
        workers: replace(snapshot.workers, worker.id, Object.freeze({ ...worker, state: 'running' as const })),
        events: appendEvent(snapshot, 'organization.worker_started', parsed.projectId, {
          workerId: worker.id,
          delegationId: worker.delegationId,
        }),
      });
    }
    case 'report_worker': {
      assertProjectWorker(snapshot, parsed, parsed.workerId);
      const worker = findWorker(snapshot, parsed.workerId);
      if (worker.state === 'proposed' || worker.state === 'authorized' || worker.state === 'offboarded' || worker.state === 'ended') {
        throw new OrganizationConflictError('Worker cannot report from its current state.');
      }
      if (snapshot.reports.some((report) => report.id === parsed.reportId)) {
        throw new OrganizationConflictError('Organization report already exists.');
      }
      const report = Object.freeze({
        version: ORGANIZATION_CONTRACT_VERSION,
        id: parsed.reportId,
        projectId: parsed.projectId,
        workerId: parsed.workerId,
        state: parsed.state,
        summaryDigest: parsed.summaryDigest,
        sequence: lastSequence(snapshot) + 1,
      });
      return Object.freeze({
        ...snapshot,
        workers: replace(snapshot.workers, worker.id, Object.freeze({ ...worker, state: nextWorkerState(parsed.state) })),
        reports: Object.freeze([...snapshot.reports, report]),
        events: appendEvent(snapshot, 'organization.report_recorded', parsed.projectId, {
          workerId: worker.id,
          reportId: report.id,
          reportState: report.state,
          summaryDigest: report.summaryDigest,
        }),
      });
    }
    case 'request_attention': {
      assertProjectWorker(snapshot, parsed, parsed.workerId);
      const worker = findWorker(snapshot, parsed.workerId);
      if (worker.state !== 'blocked' && worker.state !== 'reporting') {
        throw new OrganizationConflictError('Only a blocked or reporting worker can request attention.');
      }
      if (snapshot.attentionRequests.some((request) => request.id === parsed.attentionId)) {
        throw new OrganizationConflictError('Attention request already exists.');
      }
      const request = Object.freeze({
        version: ORGANIZATION_CONTRACT_VERSION,
        id: parsed.attentionId,
        projectId: parsed.projectId,
        workerId: parsed.workerId,
        state: 'open' as const,
        questionDigest: parsed.questionDigest,
        sequence: lastSequence(snapshot) + 1,
      });
      return Object.freeze({
        ...snapshot,
        attentionRequests: Object.freeze([...snapshot.attentionRequests, request]),
        events: appendEvent(snapshot, 'organization.attention_requested', parsed.projectId, {
          workerId: worker.id,
          attentionId: request.id,
          questionDigest: request.questionDigest,
        }),
      });
    }
    case 'answer_attention':
    case 'withdraw_attention':
    case 'expire_attention': {
      findProject(snapshot, parsed.projectId);
      const request = snapshot.attentionRequests.find((candidate) => candidate.id === parsed.attentionId);
      if (!request || request.projectId !== parsed.projectId) {
        throw new OrganizationNotFoundError('Attention request not found.');
      }
      if (request.state !== 'open') throw new OrganizationConflictError('Attention request is not open.');
      const state: AttentionState =
        parsed.type === 'answer_attention' ? 'answered' : parsed.type === 'withdraw_attention' ? 'withdrawn' : 'expired';
      return Object.freeze({
        ...snapshot,
        attentionRequests: replace(snapshot.attentionRequests, request.id, Object.freeze({ ...request, state })),
        events: appendEvent(snapshot, `organization.attention_${state}`, parsed.projectId, {
          attentionId: request.id,
          workerId: request.workerId,
          decisionDigest: parsed.decisionDigest,
        }),
      });
    }
    case 'quiet_project': {
      const project = findProject(snapshot, parsed.projectId);
      if (project.state !== 'active' && project.state !== 'resumed') {
        throw new OrganizationConflictError('Project cannot become quiet from its current state.');
      }
      return Object.freeze({
        ...snapshot,
        projects: replace(snapshot.projects, project.id, Object.freeze({ ...project, state: 'quiet' as const })),
        events: appendEvent(snapshot, 'organization.project_quieted', project.id, {
          fromState: project.state,
        }),
      });
    }
    case 'archive_project': {
      const project = findProject(snapshot, parsed.projectId);
      if (project.state !== 'quiet' && project.state !== 'active' && project.state !== 'resumed') {
        throw new OrganizationConflictError('Project cannot be archived from its current state.');
      }
      const activeWorkers = snapshot.workers.filter(
        (worker) =>
          worker.projectId === project.id &&
          (worker.state === 'proposed' ||
            worker.state === 'authorized' ||
            worker.state === 'running' ||
            worker.state === 'idle' ||
            worker.state === 'reporting' ||
            worker.state === 'blocked'),
      );
      if (activeWorkers.length > 0) {
        throw new OrganizationConflictError('Project still has active workers.');
      }
      return Object.freeze({
        ...snapshot,
        projects: replace(snapshot.projects, project.id, Object.freeze({ ...project, state: 'archived' as const })),
        events: appendEvent(snapshot, 'organization.project_archived', project.id, {
          fromState: project.state,
        }),
      });
    }
    case 'resume_project': {
      const project = findProject(snapshot, parsed.projectId);
      if (project.state !== 'archived') throw new OrganizationConflictError('Only archived projects can resume.');
      const delegation = findDelegation(snapshot, parsed.revalidatedDelegationId!);
      if (delegation.projectId !== project.id || delegation.state === 'revoked') {
        throw new OrganizationConflictError('Revalidated delegation is not active for this project.');
      }
      if (delegation.expiresAtSequence <= lastSequence(snapshot)) {
        throw new OrganizationConflictError('Revalidated delegation has expired.');
      }
      return Object.freeze({
        ...snapshot,
        delegations: replace(
          snapshot.delegations,
          delegation.id,
          Object.freeze({ ...delegation, state: 'active' as const }),
        ),
        projects: replace(snapshot.projects, project.id, Object.freeze({ ...project, state: 'resumed' as const })),
        events: appendEvent(snapshot, 'organization.project_resumed', project.id, {
          revalidatedDelegationId: delegation.id,
          authorizationDigest: delegation.authorizationDigest,
        }),
      });
    }
    case 'offboard_worker': {
      assertProjectWorker(snapshot, parsed, parsed.workerId);
      const worker = findWorker(snapshot, parsed.workerId);
      if (worker.state === 'offboarded' || worker.state === 'ended') {
        throw new OrganizationConflictError('Worker is already inactive.');
      }
      const delegation = findDelegation(snapshot, worker.delegationId);
      return Object.freeze({
        ...snapshot,
        workers: replace(snapshot.workers, worker.id, Object.freeze({ ...worker, state: 'offboarded' as const })),
        delegations: replace(
          snapshot.delegations,
          delegation.id,
          Object.freeze({ ...delegation, state: 'revoked' as const }),
        ),
        events: appendEvent(snapshot, 'organization.worker_offboarded', parsed.projectId, {
          workerId: worker.id,
          delegationId: delegation.id,
        }),
      });
    }
    default:
      throw new OrganizationValidationError('Organization action is not accepted.');
  }
}
