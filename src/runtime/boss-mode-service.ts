import { createHash, randomUUID } from 'node:crypto';
import {
  OrganizationConflictError,
  OrganizationNotFoundError,
  OrganizationValidationError,
  type OrganizationAction,
  type OrganizationSnapshot,
} from './organization-contract.js';
import {
  OrganizationIntentParseError,
  createDeterministicOrganizationIntentParser,
  type OrganizationIntentParser,
} from './organization-intent-parser.js';
import { OrganizationCoordinator } from './organization-coordinator.js';
import type { OrganizationRelay } from './organization-execution.js';
import type { OrganizationStore } from './organization-store.js';
import type { TaskService } from './task-service.js';
import { WORK_CONTRACT_VERSION, type WorkTriggerRequest } from './work-contract.js';

export const BOSS_MODE_SERVICE_VERSION = 1;

export class BossModeServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BossModeServiceError';
  }
}

export interface BossModeSubmitInput {
  readonly text: string;
  readonly idempotencyKey: string;
}

export interface BossModeExecution {
  readonly action: OrganizationAction;
  readonly status: 'created-agent' | 'dispatched' | 'skipped' | 'failed';
  readonly detail?: string;
}

export interface BossModeSubmitResult {
  readonly version: typeof BOSS_MODE_SERVICE_VERSION;
  readonly intentId: string;
  readonly state: 'accepted';
  readonly expectedSequence: number;
  readonly actions: readonly OrganizationAction[];
  readonly executions: readonly BossModeExecution[];
  readonly relays: readonly OrganizationRelay[];
  readonly reply: string | null;
}

export interface BossModeServiceOptions {
  readonly parser?: OrganizationIntentParser;
  readonly now?: () => string;
}

function triggerDigest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function reference(value: string, length = 24): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

interface PendingIntent {
  readonly result: BossModeSubmitResult;
  readonly fingerprint: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateSubmission(input: unknown): BossModeSubmitInput {
  if (!isRecord(input)) throw new BossModeServiceError('Boss mode intent must be an object.');
  const allowed = new Set(['text', 'idempotencyKey']);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new BossModeServiceError(`Unknown fields: ${unknown.sort().join(', ')}.`);
  if (typeof input.text !== 'string' || input.text.trim().length === 0 || input.text.length > 20_000) {
    throw new BossModeServiceError('text must be a non-empty string of at most 20000 characters.');
  }
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0 || input.idempotencyKey.length > 200) {
    throw new BossModeServiceError('idempotencyKey must be a non-empty string of at most 200 characters.');
  }
  if (/sk-|Bearer|ghp_|github_pat_|password|apiKey|privateKey/i.test(`${input.text} ${input.idempotencyKey}`)) {
    throw new BossModeServiceError('Boss mode intent contains secret-like content.');
  }
  return Object.freeze({ text: input.text, idempotencyKey: input.idempotencyKey });
}

function isWorkerAction(action: OrganizationAction): action is Extract<OrganizationAction, { type: 'create_agent' }> {
  return action.type === 'create_agent';
}

function boundedError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : 'Unknown execution failure.';
  return message.slice(0, 240).replace(/[\u0000-\u001f\u007f]/g, ' ');
}

export class BossModeService {
  readonly coordinator: OrganizationCoordinator;
  private readonly parser: OrganizationIntentParser;
  private readonly now: () => string;
  private readonly intents = new Map<string, PendingIntent>();
  private readonly agentRevisionIds = new Map<string, string>();
  private readonly agentIds = new Map<string, string>();
  private readonly workItems = new Map<string, string>();

  constructor(
    private readonly store: OrganizationStore,
    private readonly taskService: TaskService | undefined,
    options: BossModeServiceOptions = {},
  ) {
    this.parser = options.parser ?? createDeterministicOrganizationIntentParser();
    this.now = options.now ?? (() => new Date().toISOString());
    this.coordinator = new OrganizationCoordinator(store, {
      listWorkState: () => this.listWorkState(),
      startWork: (workItemId, expectedState) => { this.workControl('startWork', workItemId, expectedState); },
      stopWork: (workItemId, expectedState) => { this.workControl('stopWork', workItemId, expectedState); },
      completeWork: (workItemId, expectedState) => { this.workControl('completeWork', workItemId, expectedState); },
      reconcileAssignment: (workItemId, assignmentId, expectedState, outcome) => {
        this.reconcileAssignment(assignmentId, outcome);
      },
    });
  }

  async submit(input: unknown): Promise<BossModeSubmitResult> {
    const submission = validateSubmission(input);
    const fingerprint = JSON.stringify([submission.text, submission.idempotencyKey]);
    const replayed = this.intents.get(submission.idempotencyKey);
    if (replayed) {
      if (replayed.fingerprint !== fingerprint) {
        throw new OrganizationConflictError('Boss mode idempotency key conflicts with its original body.');
      }
      return replayed.result;
    }

    const before = this.store.get();
    const intentId = `int_${randomUUID().replaceAll('-', '')}`;
    const parsed = await this.parser.parse({
      intentId,
      text: submission.text,
      expectedSequence: before.events.length,
    });

    const actions: OrganizationAction[] = [];
    const executions: BossModeExecution[] = [];
    let sequence = before.events.length;

    for (const action of parsed.actions) {
      if (isWorkerAction(action)) {
        const execution = await this.createDynamicAgent(action);
        actions.push(action);
        executions.push(execution);
        continue;
      }
      const candidate = Object.freeze({ ...action, expectedSequence: this.store.get().events.length });
      const after = this.store.apply(candidate);
      sequence = after.events.length;
      actions.push(candidate);
      if (action.type === 'authorize_worker') continue;
      if (action.type === 'start_worker') {
        const workExecution = this.ensureWorkItem(action);
        executions.push(workExecution);
        continue;
      }
      executions.push(Object.freeze({ action: candidate, status: 'dispatched' as const }));
    }

    const coordination = this.coordinator.reconcile();
    const result: BossModeSubmitResult = Object.freeze({
      version: BOSS_MODE_SERVICE_VERSION,
      intentId,
      state: 'accepted' as const,
      expectedSequence: sequence,
      actions: Object.freeze(actions),
      executions: Object.freeze(executions),
      relays: coordination.relays,
      reply: parsed.relay,
    });
    this.intents.set(submission.idempotencyKey, { result, fingerprint });
    return result;
  }

  getDynamicAgentRevisionId(workerId: string): string | undefined {
    return this.agentRevisionIds.get(workerId);
  }

  get organizationStore(): OrganizationStore {
    return this.store;
  }

  private async createDynamicAgent(action: Extract<OrganizationAction, { type: 'create_agent' }>): Promise<BossModeExecution> {
    if (!this.taskService) {
      return Object.freeze({ action, status: 'failed' as const, detail: 'Task service is unavailable.' });
    }
    try {
      const instructions = [
        `You are ${action.displayName}.`,
        `Work only within project scope: ${action.scope.join(', ')}.`,
        'Produce bounded structured progress reports; do not request tools or secrets.',
      ].join(' ');
      const agent = await this.taskService.createAgent({
        name: action.displayName,
        instructions,
        providerId: action.model.providerId,
        modelId: action.model.modelId,
      });
      const normalized = Object.freeze({
        ...action,
        expectedSequence: this.store.get().events.length,
        agentRevisionId: agent.currentRevisionId,
      });
      this.store.apply(normalized);
      this.agentRevisionIds.set(action.workerId, agent.currentRevisionId);
      this.agentIds.set(action.workerId, agent.id);
      const authorize = Object.freeze({
        type: 'authorize_worker' as const,
        expectedSequence: this.store.get().events.length,
        projectId: action.projectId,
        workerId: action.workerId,
      });
      this.store.apply(authorize);
      const start = Object.freeze({
        type: 'start_worker' as const,
        expectedSequence: this.store.get().events.length,
        projectId: action.projectId,
        workerId: action.workerId,
      });
      this.store.apply(start);
      const workExecution = this.ensureWorkItem(start);
      if (workExecution.status === 'failed') {
        return Object.freeze({
          action: normalized,
          status: 'failed' as const,
          detail: workExecution.detail ?? 'WorkItem binding failed.',
        });
      }
      return Object.freeze({ action: normalized, status: 'created-agent' as const });
    } catch (cause) {
      return Object.freeze({ action, status: 'failed' as const, detail: boundedError(cause) });
    }
  }

  private listWorkState() {
    const platform = this.taskService?.store.platform;
    if (!platform) return [];
    return platform.listWorkItems().map((item) => {
      const detail = platform.getWorkItemDetail(item.id);
      const assignmentIds = detail.assignments.map((assignment) => assignment.id);
      return Object.freeze({
        id: item.id,
        state: item.state,
        assignmentIds,
        interruptedAssignmentIds: detail.assignments
          .filter((assignment) => assignment.state === 'interrupted')
          .map((assignment) => assignment.id),
      });
    });
  }

  private ensureWorkItem(action: Extract<OrganizationAction, { type: 'start_worker' }>): BossModeExecution {
    const taskService = this.taskService;
    if (!taskService) {
      return Object.freeze({ action, status: 'failed' as const, detail: 'Task service is unavailable.' });
    }
    if (this.workItems.has(action.workerId)) {
      return Object.freeze({ action, status: 'skipped' as const, detail: 'WorkItem already bound.' });
    }
    const revisionId = this.agentRevisionIds.get(action.workerId);
    const agentId = this.agentIds.get(action.workerId);
    if (!revisionId || !agentId) {
      return Object.freeze({ action, status: 'skipped' as const, detail: 'No validated Agent revision.' });
    }
    try {
      const revision = taskService.getAgentRevision(agentId, revisionId);
      const stableKey = `${action.projectId}:${action.workerId}`;
      const request: WorkTriggerRequest = {
        source: { sourceId: 'boss-mode', kind: 'fake' },
        trigger: {
          triggerId: `boss_${reference(stableKey)}`,
          threadKey: `boss:${stableKey}`,
          payloadDigest: triggerDigest(stableKey),
          occurredAt: this.now(),
        },
        mandate: {
          scope: [`project:${action.projectId}`],
          allowedOperations: ['observe'],
          capabilitiesDigest: triggerDigest(`capabilities:${stableKey}`),
        },
        model: { providerId: revision.providerId, modelId: revision.modelId },
        agentRevisionId: revision.id,
        configurationRevisionId: taskService.activeConfigurationRevisionId,
      };
      const envelope = taskService.store.work.ingestWorkTrigger(request);
      this.workItems.set(action.workerId, envelope.workItem.id);
      return Object.freeze({ action, status: 'dispatched' as const });
    } catch (cause) {
      return Object.freeze({ action, status: 'failed' as const, detail: boundedError(cause) });
    }
  }

  private workControl(name: string, workItemId: string, expectedState: string): void {
    const platform = this.taskService?.store.platform;
    if (!platform) throw new BossModeServiceError(`${name} is unavailable.`);
    if (name === 'startWork') platform.startWork(workItemId, expectedState as 'open' | 'paused');
    else if (name === 'stopWork') platform.stopWork(workItemId, expectedState as 'running' | 'paused');
    else if (name === 'completeWork') platform.completeWork(workItemId, expectedState as 'running');
    else throw new BossModeServiceError(`${name} is unsupported.`);
  }

  private reconcileAssignment(assignmentId: string, outcome: 'succeeded' | 'failed'): void {
    const platform = this.taskService?.store.platform;
    if (!platform) throw new BossModeServiceError('reconcileAssignment is unavailable.');
    platform.reconcileAssignment({ assignmentId, outcome });
  }

  snapshot(): OrganizationSnapshot {
    return this.store.get();
  }
}

export { OrganizationIntentParseError, OrganizationValidationError, OrganizationNotFoundError };
