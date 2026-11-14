import { createHash } from 'node:crypto';
import {
  OrganizationConflictError,
  OrganizationNotFoundError,
  OrganizationValidationError,
  parseOrganizationAction,
  type OrganizationAction,
  type OrganizationSnapshot,
} from './organization-contract.js';
import {
  OrganizationIntentParseError,
  createDeterministicOrganizationIntentParser,
  type OrganizationIntentParser,
  type OrganizationIntentParseResult,
} from './organization-intent-parser.js';
import { chineseAgentDisplayName } from './agent-name.js';
import { OrganizationCoordinator } from './organization-coordinator.js';
import type { OrganizationRelay } from './organization-execution.js';
import type { OrganizationStore } from './organization-store.js';
import type { TaskService } from './task-service.js';
import { type WorkTriggerRequest } from './work-contract.js';

export const BOSS_MODE_SERVICE_VERSION = 2;

export class BossModeServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BossModeServiceError';
  }
}

export interface BossModeSubmitInput {
  readonly text: string;
  readonly idempotencyKey: string;
  readonly conversation?: readonly {
    readonly author: 'user' | 'assistant';
    readonly body: string;
  }[];
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
  readonly waitForTasks?: boolean;
  readonly conversation?: {
    recordIntentText(intentId: string, text: string): void;
  };
  readonly onAccepted?: (result: BossModeSubmitResult) => void;
}

interface WorkerExecutionRecord {
  readonly workerId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly workItemId: string;
  readonly agentId: string;
  readonly agentRevisionId: string;
  readonly delegationId: string;
}

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function reference(value: string, length = 24): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

function intentId(idempotencyKey: string): string {
  return `int_${digest(`intent:${idempotencyKey}`).slice(7, 31)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateSubmission(input: unknown): BossModeSubmitInput {
  if (!isRecord(input)) throw new BossModeServiceError('Boss mode intent must be an object.');
  const allowed = new Set(['text', 'idempotencyKey']);
  const conversation = isRecord(input.conversation) || Array.isArray(input.conversation)
    ? input.conversation
    : undefined;
  const unknown = Object.keys(input).filter((key) => !allowed.has(key) && key !== 'conversation');
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
  let boundedConversation: readonly { readonly author: 'user' | 'assistant'; readonly body: string }[] | undefined;
  if (conversation !== undefined) {
    if (!Array.isArray(conversation) || conversation.length > 8) {
      throw new BossModeServiceError('conversation must contain at most 8 bounded messages.');
    }
    boundedConversation = Object.freeze(conversation.map((item, index) => {
      if (!isRecord(item) || (item.author !== 'user' && item.author !== 'assistant')
        || typeof item.body !== 'string' || item.body.length === 0 || item.body.length > 6000
        || /sk-|Bearer|ghp_|github_pat_|password|apiKey|privateKey/i.test(item.body)) {
        throw new BossModeServiceError(`conversation[${index}] is not a bounded safe message.`);
      }
      return Object.freeze({ author: item.author, body: item.body });
    }));
  }
  return Object.freeze({
    text: input.text,
    idempotencyKey: input.idempotencyKey,
    ...(boundedConversation ? { conversation: boundedConversation } : {}),
  });
}

function boundedError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : 'Unknown execution failure.';
  return message.slice(0, 240).replace(/[\u0000-\u001f\u007f]/g, ' ');
}

function actionAt(action: OrganizationAction, expectedSequence: number): OrganizationAction {
  return Object.freeze({ ...action, expectedSequence }) as OrganizationAction;
}

function applyAction(store: OrganizationStore, action: OrganizationAction, projectId?: string): OrganizationSnapshot {
  const expectedSequence = store.get().events.length;
  return store.apply(actionAt({ ...action, projectId: projectId ?? action.projectId } as OrganizationAction, expectedSequence));
}

export class BossModeService {
  readonly coordinator: OrganizationCoordinator;
  private readonly parser: OrganizationIntentParser;
  private readonly now: () => string;
  private readonly waitForTasks: boolean;
  private readonly conversation: BossModeServiceOptions['conversation'];
  private readonly onAccepted: BossModeServiceOptions['onAccepted'];
  private readonly workerExecutions = new Map<string, WorkerExecutionRecord>();
  private readonly startedWorkers = new Set<string>();
  private readonly outcomeByTaskId = new Map<string, string>();

  constructor(
    private readonly store: OrganizationStore,
    private readonly taskService: TaskService | undefined,
    options: BossModeServiceOptions = {},
  ) {
    this.parser = options.parser ?? createDeterministicOrganizationIntentParser();
    this.now = options.now ?? (() => new Date().toISOString());
    this.waitForTasks = options.waitForTasks ?? true;
    this.conversation = options.conversation;
    this.onAccepted = options.onAccepted;
    this.restoreRecords();
    this.coordinator = new OrganizationCoordinator(store, {
      listWorkState: () => this.listWorkState(),
      startWork: (workItemId, expectedState) => { this.workControl('startWork', workItemId, expectedState); },
      stopWork: (workItemId, expectedState) => { this.workControl('stopWork', workItemId, expectedState); },
      completeWork: (workItemId, expectedState) => { this.workControl('completeWork', workItemId, expectedState); },
      reconcileAssignment: (_workItemId, assignmentId, _expectedState, outcome) => {
        this.reconcileAssignment(assignmentId, outcome);
      },
    });
  }

  async submit(
    input: unknown,
    onAccepted?: (result: BossModeSubmitResult) => void,
  ): Promise<BossModeSubmitResult> {
    const submission = validateSubmission(input);
    const resolvedIntentId = intentId(submission.idempotencyKey);
    this.conversation?.recordIntentText(resolvedIntentId, submission.text);
    const bodyDigest = digest(JSON.stringify([submission.text, resolvedIntentId]));
    const recorded = this.findRecordedIntent(resolvedIntentId, bodyDigest);
    if (recorded) return recorded;

    const snapshot = this.store.get();
    const parseInput = {
      intentId: resolvedIntentId,
      text: submission.text,
      expectedSequence: snapshot.events.length,
      snapshot,
      ...(submission.conversation ? { conversation: submission.conversation } : {}),
    };
    const modelReference = await this.resolveModelReference();
    const parsed = await this.prepareParsedActions({ ...parseInput, modelReference }, modelReference);
    const actions: OrganizationAction[] = [];
    const executions: BossModeExecution[] = [];
    const createdWorkers: WorkerExecutionRecord[] = [];
    let acceptedPublished = false;
    let sequence = snapshot.events.length;

    for (const parsedAction of parsed.actions) {
      const action = actionAt(parsedAction, sequence);
      sequence += 1;
      actions.push(action);

      if (action.type === 'record_intent') {
        applyAction(this.store, action, action.projectId);
        executions.push(Object.freeze({ action, status: 'dispatched' as const }));
        continue;
      }
      if (action.type === 'create_agent') {
        const execution = await this.createDynamicAgent(action, modelReference);
        executions.push(execution);
        if (execution.status === 'created-agent') {
          const record = this.workerExecutions.get(action.workerId);
          if (record) createdWorkers.push(record);
        }
        continue;
      }
      if (action.type === 'start_worker') {
        if (this.startedWorkers.has(action.workerId) || !this.workerExecutions.has(action.workerId)) {
          executions.push(Object.freeze({ action, status: 'skipped' as const, detail: 'Worker already started.' }));
          continue;
        }
        const worker = this.store.get().workers.find((item) => item.id === action.workerId);
        if (worker && ['authorized', 'idle'].includes(worker.state)) applyAction(this.store, action);
        this.startedWorkers.add(action.workerId);
        executions.push(this.ensureWorkItem(action));
        continue;
      }
      if (action.type === 'open_project' || action.type === 'activate_project') {
        applyAction(this.store, action);
        executions.push(Object.freeze({ action, status: 'dispatched' as const }));
        continue;
      }
      if (action.type === 'quiet_project' || action.type === 'archive_project') {
        const execution = this.runLifecycleBatch(action);
        executions.push(execution);
        continue;
      }
      if (action.type === 'resume_project') {
        const execution = this.runLifecycleBatch(action);
        executions.push(execution);
        continue;
      }
      if (action.type === 'answer_attention' || action.type === 'withdraw_attention' || action.type === 'expire_attention') {
        const execution = this.answerAttention(action as Extract<OrganizationAction, { type: 'answer_attention' }>);
        executions.push(execution);
        continue;
      }
      applyAction(this.store, action);
      executions.push(Object.freeze({ action, status: 'dispatched' as const }));
    }

    const publishAccepted = () => {
      if (acceptedPublished) return;
      acceptedPublished = true;
      const accepted: BossModeSubmitResult = Object.freeze({
        version: BOSS_MODE_SERVICE_VERSION,
        intentId: resolvedIntentId,
        state: 'accepted' as const,
        expectedSequence: this.store.get().events.length,
        actions: Object.freeze(actions),
        executions: Object.freeze(executions),
        relays: Object.freeze([]),
        reply: parsed.relay,
      });
      onAccepted?.(accepted);
      this.onAccepted?.(accepted);
    };
    publishAccepted();
    if (createdWorkers.length > 0 && this.waitForTasks) {
      await this.collectWorkerOutcomes(createdWorkers);
    }
    const coordination = this.coordinator.reconcile();
    const result: BossModeSubmitResult = Object.freeze({
      version: BOSS_MODE_SERVICE_VERSION,
      intentId: resolvedIntentId,
      state: 'accepted' as const,
      expectedSequence: this.store.get().events.length,
      actions: Object.freeze(actions),
      executions: Object.freeze(executions),
      relays: coordination.relays,
      reply: parsed.relay,
    });
    if (this.store.get().events.some((event) =>
      event.type === 'organization.intent_recorded' && event.data.intentId === resolvedIntentId) === false) {
      this.recordIntent(resolvedIntentId, bodyDigest, actions.length);
    }
    if (executions.some((execution) => execution.status === 'failed')) {
      throw new BossModeServiceError('Boss mode execution failed; see bounded execution details.');
    }
    return result;
  }

  get organizationStore(): OrganizationStore {
    return this.store;
  }

  getDynamicAgentRevisionId(workerId: string): string | undefined {
    return this.workerExecutions.get(workerId)?.agentRevisionId;
  }

  snapshot(): OrganizationSnapshot {
    return this.store.get();
  }

  decideAttention(
    attentionId: string,
    kind: 'answer' | 'withdraw',
    expectedVersion: number,
    decisionDigest?: string,
  ): OrganizationSnapshot {
    const snapshot = this.store.get();
    const request = snapshot.attentionRequests.find((item) => item.id === attentionId);
    if (!request) throw new OrganizationNotFoundError('Attention request not found.');
    if (request.state !== 'open') throw new OrganizationConflictError('AttentionRequest is not open.');
    if (request.sequence !== expectedVersion) {
      throw new OrganizationConflictError('AttentionRequest expectedVersion is stale.');
    }
    const action = parseOrganizationAction({
      type: kind === 'answer' ? 'answer_attention' : 'withdraw_attention',
      expectedSequence: snapshot.events.length,
      projectId: request.projectId,
      attentionId,
      decisionDigest: decisionDigest ?? digest(`decision:${attentionId}:${expectedVersion}`),
    });
    this.answerAttention(action as Extract<OrganizationAction, { type: 'answer_attention' }>);
    return this.store.get();
  }

  private async resolveModelReference(): Promise<{ providerId: string; modelId: string }> {
    const taskService = this.taskService;
    if (!taskService) throw new BossModeServiceError('Task service is unavailable.');
    try {
      const models = await taskService.listProviderModels();
      const first = models[0];
      if (!first) throw new BossModeServiceError('No provider model is available.');
      return Object.freeze({ providerId: first.providerId, modelId: first.modelId });
    } catch (cause) {
      throw new BossModeServiceError(`Model catalog is unavailable: ${boundedError(cause)}`);
    }
  }

  private async prepareParsedActions(
    parseInput: Parameters<OrganizationIntentParser['parse']>[0],
    modelReference: { providerId: string; modelId: string },
  ): Promise<OrganizationIntentParseResult> {
    const parsed = await this.parser.parse({ ...parseInput, modelReference });
    const body = JSON.stringify([parseInput.text, parseInput.intentId]);
    const bodyDigest = digest(body);
    const snapshot = this.store.get();
    const projectId = parseInput.snapshot?.projects.at(-1)?.id
      ?? snapshot.projects.at(-1)?.id
      ?? `project_${reference('primary')}`;
    const actions: OrganizationAction[] = [
      parseOrganizationAction({
        type: 'record_intent',
        expectedSequence: snapshot.events.length,
        projectId,
        intentId: parseInput.intentId,
        bodyDigest,
        actionCount: parsed.actions.length,
      }),
    ];
    for (const candidate of parsed.actions) {
        const action = candidate.type === 'create_agent'
        ? Object.freeze({ ...candidate, model: modelReference })
        : candidate;
      actions.push(actionAt(parseOrganizationAction(action), snapshot.events.length + actions.length));
    }
    return Object.freeze({ ...parsed, actions: Object.freeze(actions) });
  }

  private findRecordedIntent(resolvedIntentId: string, bodyDigest: string): BossModeSubmitResult | null {
    const snapshot = this.store.get();
    for (const event of snapshot.events) {
      if (event.type !== 'organization.intent_recorded') continue;
      if (event.data.intentId === resolvedIntentId && event.data.bodyDigest !== bodyDigest) {
        throw new OrganizationConflictError('Boss mode idempotency key conflicts with its original body.');
      }
      if (event.data.intentId === resolvedIntentId) {
        const projectId = event.projectId;
        const actionCount = typeof event.data.actionCount === 'number' ? event.data.actionCount : 0;
        return Object.freeze({
          version: BOSS_MODE_SERVICE_VERSION,
          intentId: resolvedIntentId,
          state: 'accepted' as const,
          expectedSequence: snapshot.events.length,
          actions: Object.freeze([parseOrganizationAction({
            type: 'record_intent',
            expectedSequence: event.sequence,
            projectId,
            intentId: resolvedIntentId,
            bodyDigest,
            actionCount,
          })]),
          executions: Object.freeze([]),
          relays: Object.freeze([]),
          reply: '意图已记录，等待 Runtime 发布状态。',
        });
      }
    }
    return null;
  }

  private recordIntent(resolvedIntentId: string, bodyDigest: string, actionCount: number): void {
    const snapshot = this.store.get();
    const projectId = snapshot.projects.at(-1)?.id ?? `project_${reference('primary')}`;
    if (snapshot.projects.length === 0) {
      this.store.apply({
        type: 'open_project',
        expectedSequence: snapshot.events.length,
        projectId,
        originTriggerId: resolvedIntentId,
      });
    }
    applyAction(this.store, {
      type: 'record_intent',
      expectedSequence: this.store.get().events.length,
      projectId,
      intentId: resolvedIntentId,
      bodyDigest,
      actionCount,
    });
  }

  private async createDynamicAgent(
    action: Extract<OrganizationAction, { type: 'create_agent' }>,
    modelReference: { providerId: string; modelId: string },
  ): Promise<BossModeExecution> {
    const taskService = this.taskService;
    if (!taskService) return Object.freeze({ action, status: 'failed' as const, detail: 'Task service is unavailable.' });
    try {
      const displayName = chineseAgentDisplayName(action.displayName);
      const instructions = [
        `你是${displayName}。`,
        `Work only within project scope: ${action.scope.join(', ')}.`,
        'Return a concise bounded result. Prefix output with ATTENTION: only when human input is required.',
      ].join(' ');
      const agent = await taskService.createAgent({
        name: displayName,
        instructions,
        providerId: modelReference.providerId,
        modelId: modelReference.modelId,
      });
      const normalized = Object.freeze({ ...action, agentRevisionId: agent.currentRevisionId, model: modelReference });
      applyAction(this.store, normalized);
      const authorize = parseOrganizationAction({
        type: 'authorize_worker',
        expectedSequence: this.store.get().events.length,
        projectId: action.projectId,
        workerId: action.workerId,
      });
      applyAction(this.store, authorize);
      const record = this.ensureExecutionRecord(normalized, agent.id);
      const start = parseOrganizationAction({
        type: 'start_worker',
        expectedSequence: this.store.get().events.length,
        projectId: action.projectId,
        workerId: action.workerId,
      });
      const worker = this.store.get().workers.find((item) => item.id === action.workerId);
      if (worker && ['authorized', 'idle'].includes(worker.state)) {
        applyAction(this.store, start);
        this.startedWorkers.add(action.workerId);
        const execution = this.ensureWorkItem(start as Extract<OrganizationAction, { type: 'start_worker' }>);
        if (execution.status === 'failed') {
          return Object.freeze({
            action: normalized,
            status: 'failed' as const,
            detail: execution.detail ?? 'WorkItem binding failed.',
          });
        }
      }
      return Object.freeze({ action: normalized, status: 'created-agent' as const });
    } catch (cause) {
      return Object.freeze({ action, status: 'failed' as const, detail: boundedError(cause) });
    }
  }

  private ensureExecutionRecord(
    action: Extract<OrganizationAction, { type: 'create_agent' }>,
    agentId: string,
  ): WorkerExecutionRecord {
    const taskService = this.taskService!;
    const snapshot = this.store.get();
      const prompt = `请执行${chineseAgentDisplayName(action.displayName)}的限定项目任务。返回简洁结果；需要人工输入时以 ATTENTION: 开头。`;
    const task = taskService.store.createAgentTask({
      id: `task_${reference(`${action.workerId}:${snapshot.events.length}`)}`,
      prompt,
      agentId,
      expectedAgentRevisionId: action.agentRevisionId,
    });
    const stableKey = `${action.projectId}:${action.workerId}:${snapshot.events.length}`;
    const request: WorkTriggerRequest = {
      source: { sourceId: 'boss-mode', kind: 'fake' },
      trigger: {
        triggerId: `boss_${reference(stableKey)}`,
        threadKey: `boss:${stableKey}`,
        payloadDigest: digest(stableKey),
        occurredAt: this.now(),
      },
      mandate: {
        scope: action.scope,
        allowedOperations: ['observe'],
        capabilitiesDigest: digest(`capabilities:${stableKey}`),
      },
      model: action.model,
      agentRevisionId: action.agentRevisionId,
      configurationRevisionId: task.configurationRevisionId,
    };
    const envelope = taskService.store.work.ingestWorkTrigger(request);
    const record = Object.freeze({
      workerId: action.workerId,
      projectId: action.projectId,
      taskId: task.id,
      workItemId: envelope.workItem.id,
      agentId,
      agentRevisionId: action.agentRevisionId,
      delegationId: action.delegationId,
    });
    this.workerExecutions.set(action.workerId, record);
    applyAction(this.store, {
      type: 'record_worker_execution',
      expectedSequence: this.store.get().events.length,
      projectId: action.projectId,
      workerId: action.workerId,
      taskId: task.id,
      workItemId: envelope.workItem.id,
      agentId,
    });
    return record;
  }

  private ensureWorkItem(action: Extract<OrganizationAction, { type: 'start_worker' }>): BossModeExecution {
    const record = this.workerExecutions.get(action.workerId);
    if (!record) return Object.freeze({ action, status: 'skipped' as const, detail: 'No validated Agent revision.' });
    const platform = this.taskService?.store.platform;
    if (!platform) return Object.freeze({ action, status: 'failed' as const, detail: 'Platform store is unavailable.' });
    const snapshot = this.store.get();
    if (snapshot.attentionRequests.some((request) => request.state === 'open')) {
      return Object.freeze({ action, status: 'skipped' as const, detail: 'Open attention blocks new work.' });
    }
    try {
      platform.startWork(record.workItemId, 'open');
      this.taskService?.startTask(record.taskId);
      return Object.freeze({ action, status: 'dispatched' as const });
    } catch (cause) {
      return Object.freeze({ action, status: 'failed' as const, detail: boundedError(cause) });
    }
  }

  private async collectWorkerOutcomes(records: readonly WorkerExecutionRecord[]): Promise<void> {
    const taskService = this.taskService;
    if (!taskService) return;
    for (const record of records) {
      if (this.outcomeByTaskId.get(record.taskId)) continue;
      let task = taskService.store.getTask(record.taskId);
      if (!task) continue;
      while (!['succeeded', 'failed', 'cancelled', 'interrupted'].includes(task.state)) {
        await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
        const next = taskService.store.getTask(record.taskId);
        if (!next) return;
        task = next;
      }
      const output = task.state === 'succeeded' ? task.output ?? '' : task.error ?? task.state;
      const summaryDigest = digest(`${record.taskId}:${task.state}:${output}`);
      const reportId = `rpt_${reference(`${record.taskId}:report`)}`;
      const needsAttention = /^\s*ATTENTION:/i.test(output);
      applyAction(this.store, {
        type: 'report_worker',
        expectedSequence: this.store.get().events.length,
        projectId: record.projectId,
        workerId: record.workerId,
        reportId,
        state: needsAttention ? 'attention' : task.state === 'succeeded' ? 'ready' : 'failed',
        summaryDigest,
      });
      if (needsAttention) {
        applyAction(this.store, {
          type: 'request_attention',
          expectedSequence: this.store.get().events.length,
          projectId: record.projectId,
          workerId: record.workerId,
          attentionId: `att_${reference(`${record.taskId}:attention`)}`,
          questionDigest: summaryDigest,
        });
      }
      this.outcomeByTaskId.set(record.taskId, summaryDigest);
      if (taskService.store.platform.getWorkItemDetail(record.workItemId).workItem.state === 'running') {
        taskService.store.platform.completeWork(record.workItemId, 'running');
      }
    }
  }

  private answerAttention(action: {
    readonly type: 'answer_attention' | 'withdraw_attention' | 'expire_attention';
    readonly expectedSequence: number;
    readonly projectId: string;
    readonly attentionId: string;
    readonly decisionDigest: string;
  }): BossModeExecution {
    const taskService = this.taskService;
    if (!taskService) return Object.freeze({ action, status: 'failed' as const, detail: 'Task service is unavailable.' });
    const snapshot = this.store.get();
    const request = snapshot.attentionRequests.find((item) => item.id === action.attentionId && item.state === 'open');
    if (!request) return Object.freeze({ action, status: 'skipped' as const, detail: 'Attention is not open.' });
    const record = this.workerExecutions.get(request.workerId);
    applyAction(this.store, action);
    if (!record) return Object.freeze({ action, status: 'dispatched' as const });
    const retry = taskService.retryTask(record.taskId);
    taskService.startTask(retry.id);
    return Object.freeze({ action, status: 'dispatched' as const });
  }

  private runLifecycleBatch(action: OrganizationAction): BossModeExecution {
    const snapshot = this.store.get();
    const project = snapshot.projects.find((item) => item.id === action.projectId);
    if (!project) return Object.freeze({ action, status: 'failed' as const, detail: 'Project not found.' });
    if (action.type === 'quiet_project' || action.type === 'archive_project') {
      for (const worker of snapshot.workers.filter((item) => item.projectId === project.id && item.state !== 'ended')) {
        if (!['offboarded', 'ended'].includes(worker.state)) {
          applyAction(this.store, {
            type: 'offboard_worker',
            expectedSequence: this.store.get().events.length,
            projectId: project.id,
            workerId: worker.id,
          });
        }
      }
      if (['active', 'resumed'].includes(project.state)) {
        applyAction(this.store, { type: 'quiet_project', expectedSequence: this.store.get().events.length, projectId: project.id });
      }
      if (action.type === 'archive_project' && this.store.get().projects.find((item) => item.id === project.id)?.state !== 'archived') {
        applyAction(this.store, { type: 'archive_project', expectedSequence: this.store.get().events.length, projectId: project.id });
      }
      return Object.freeze({ action, status: 'dispatched' as const });
    }
    if (action.type === 'resume_project') {
      const delegation = snapshot.delegations.find((item) => item.projectId === project.id);
      if (!delegation) return Object.freeze({ action, status: 'failed' as const, detail: 'No delegation to revalidate.' });
      applyAction(this.store, {
        type: 'activate_delegation',
        expectedSequence: this.store.get().events.length,
        projectId: project.id,
        delegationId: delegation.id,
      });
      applyAction(this.store, {
        type: 'resume_project',
        expectedSequence: this.store.get().events.length,
        projectId: project.id,
        revalidatedDelegationId: delegation.id,
      });
      for (const worker of snapshot.workers.filter((item) => item.projectId === project.id && item.state === 'offboarded')) {
        applyAction(this.store, {
          type: 'resume_worker',
          expectedSequence: this.store.get().events.length,
          projectId: project.id,
          workerId: worker.id,
        });
        const record = this.workerExecutions.get(worker.id);
        if (record && this.taskService) {
          const retry = this.taskService.retryTask(record.taskId);
          this.taskService.startTask(retry.id);
        }
      }
      return Object.freeze({ action, status: 'dispatched' as const });
    }
    applyAction(this.store, action);
    return Object.freeze({ action, status: 'dispatched' as const });
  }

  private restoreRecords(): void {
    let snapshot: OrganizationSnapshot;
    try {
      snapshot = this.store.get();
    } catch {
      return;
    }
    for (const event of snapshot.events) {
      if (event.type === 'organization.worker_execution_recorded') {
        const workerId = String(event.data.workerId ?? '');
        const projectId = event.projectId;
        const taskId = String(event.data.taskId ?? '');
        const workItemId = String(event.data.workItemId ?? '');
        const agentId = String(event.data.agentId ?? '');
        if (!workerId || !taskId || !workItemId || !agentId) continue;
        const worker = snapshot.workers.find((item) => item.id === workerId);
        if (!worker) continue;
        this.workerExecutions.set(workerId, Object.freeze({
          workerId,
          projectId,
          taskId,
          workItemId,
          agentId,
          agentRevisionId: worker.agentRevisionId,
          delegationId: worker.delegationId,
        }));
      }
    }
  }

  private listWorkState() {
    const platform = this.taskService?.store.platform;
    if (!platform) return [];
    return platform.listWorkItems().map((item) => {
      const detail = platform.getWorkItemDetail(item.id);
      return Object.freeze({
        id: item.id,
        state: item.state,
        assignmentIds: detail.assignments.map((assignment) => assignment.id),
        interruptedAssignmentIds: detail.assignments
          .filter((assignment) => assignment.state === 'interrupted')
          .map((assignment) => assignment.id),
      });
    });
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
}

export { OrganizationIntentParseError, OrganizationValidationError, OrganizationNotFoundError };
