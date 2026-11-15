import { createHash, randomUUID } from 'node:crypto';
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
import type { CapabilityGrant } from './agent-profile.js';
import { OrganizationCoordinator } from './organization-coordinator.js';
import type { OrganizationRelay } from './organization-execution.js';
import type { OrganizationStore } from './organization-store.js';
import type { TaskService } from './task-service.js';
import { type WorkTriggerRequest } from './work-contract.js';
import { buildBossOrganizationFacts, runtimeCapabilityFacts } from './boss-organization-context.js';
import { containsSecretLike } from './secret-filter.js';
import { MEMORY_LIMITS, renderMemoryIndex, type AgentMemoryInput, type AgentMemoryStore } from './agent-memory.js';
import type { MemoryReviewInput, MemoryReviewResult } from './memory-review.js';

export const BOSS_MODE_SERVICE_VERSION = 2;

/**
 * The provider the Boss conversation talks to. Magpie is currently the only
 * compatibility adapter; when a second adapter is accepted this becomes an
 * explicit configuration value rather than a literal.
 */
export const BOSS_UPSTREAM_PROVIDER_ID = 'magpie';

export class BossModeServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BossModeServiceError';
  }
}

export interface BossModeSubmitInput {
  readonly text: string;
  readonly idempotencyKey: string;
  readonly modelOverride?: {
    readonly providerId: string;
    readonly modelId: string;
  };
  readonly reasoningEffort?: 'low' | 'medium' | 'high';
  readonly source?: 'primary-conversation' | 'agent-chat';
  readonly conversation?: readonly {
    readonly author: 'user' | 'assistant';
    readonly body: string;
  }[];
  readonly onProgress?: (progress: {
    readonly state: 'streaming' | 'organizing';
    readonly percent: number | null;
    readonly previousText?: string;
  }) => void;
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
  /**
   * The model the Boss conversation is configured to use. When present it wins
   * over the provider catalog order, so the Boss never silently runs on a model
   * the operator did not choose.
   */
  readonly bossModelReference?: { readonly providerId: string; readonly modelId: string };
  /**
   * Capabilities granted to dynamically hired worker Agents. Defaults to the
   * Runtime's registered read-only built-ins; writes, MCP, and plugin
   * capabilities are never granted implicitly.
   */
  readonly workerCapabilityGrants?: () => readonly CapabilityGrant[];
  readonly conversation?: {
    recordIntentText(intentId: string, text: string): void;
    intentTexts?(): ReadonlyMap<string, string>;
  };
  readonly onAccepted?: (result: BossModeSubmitResult) => void;
  /**
   * Durable recollection written by the Runtime (for example, a project's
   * close-out report). Only a bounded index is injected; bodies stay on disk.
   */
  readonly memory?: AgentMemoryStore;
  /**
   * An independent reviewer for memory the Boss proposes.
   *
   * It returns a recommendation only. Without one, a proposal is still
   * validated and written unreviewed, which is the pre-reviewer behaviour.
   */
  readonly memoryReviewer?: (input: MemoryReviewInput) => Promise<MemoryReviewResult | null>;
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

interface WorkerOutcome {
  readonly workerId: string;
  readonly displayName: string;
  readonly taskState: 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  readonly body: string;
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
  const allowed = new Set(['text', 'idempotencyKey', 'source']);
  const conversation = isRecord(input.conversation) || Array.isArray(input.conversation)
    ? input.conversation
    : undefined;
  const unknown = Object.keys(input).filter((key) =>
    !allowed.has(key) && key !== 'conversation' && key !== 'onProgress'
      && key !== 'modelOverride' && key !== 'reasoningEffort');
  if (unknown.length > 0) throw new BossModeServiceError(`Unknown fields: ${unknown.sort().join(', ')}.`);
  if (typeof input.text !== 'string' || input.text.trim().length === 0 || input.text.length > 20_000) {
    throw new BossModeServiceError('text must be a non-empty string of at most 20000 characters.');
  }
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0 || input.idempotencyKey.length > 200) {
    throw new BossModeServiceError('idempotencyKey must be a non-empty string of at most 200 characters.');
  }
  if (containsSecretLike(`${input.text} ${input.idempotencyKey}`)) {
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
        || containsSecretLike(item.body)) {
        throw new BossModeServiceError(`conversation[${index}] is not a bounded safe message.`);
      }
      return Object.freeze({ author: item.author, body: item.body });
    }));
  }
  if (input.source !== undefined && input.source !== 'primary-conversation' && input.source !== 'agent-chat') {
    throw new BossModeServiceError('source must be primary-conversation or agent-chat.');
  }
  let modelOverride: { readonly providerId: string; readonly modelId: string } | undefined;
  if (input.modelOverride !== undefined) {
    if (!isRecord(input.modelOverride)
      || typeof input.modelOverride.providerId !== 'string'
      || typeof input.modelOverride.modelId !== 'string') {
      throw new BossModeServiceError('modelOverride must contain providerId and modelId.');
    }
    modelOverride = Object.freeze({
      providerId: input.modelOverride.providerId,
      modelId: input.modelOverride.modelId,
    });
  }
  if (input.reasoningEffort !== undefined
    && input.reasoningEffort !== 'low'
    && input.reasoningEffort !== 'medium'
    && input.reasoningEffort !== 'high') {
    throw new BossModeServiceError('reasoningEffort must be low, medium, or high.');
  }
  return Object.freeze({
    text: input.text,
    idempotencyKey: input.idempotencyKey,
    ...(typeof input.onProgress === 'function'
      ? { onProgress: input.onProgress as NonNullable<BossModeSubmitInput['onProgress']> }
      : {}),
    ...(input.source ? { source: input.source } : {}),
    ...(modelOverride ? { modelOverride } : {}),
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
    ...(boundedConversation ? { conversation: boundedConversation } : {}),
  });
}

function boundedError(cause: unknown): string {
  // A thrown non-Error still carries a diagnostic: stringify it rather than
  // collapsing every such case into one opaque sentence.
  let message: string;
  if (cause instanceof Error) {
    message = cause.message;
  } else if (typeof cause === 'string') {
    message = cause;
  } else {
    try {
      message = JSON.stringify(cause) ?? String(cause);
    } catch {
      message = String(cause);
    }
  }
  const bounded = message.trim().length > 0 ? message : 'Unknown execution failure.';
  return bounded.slice(0, 240).replace(/[\u0000-\u001f\u007f]/g, ' ');
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
  private readonly bossModelReference: { readonly providerId: string; readonly modelId: string } | undefined;
  private readonly workerCapabilityGrants: () => readonly CapabilityGrant[];
  private readonly conversation: BossModeServiceOptions['conversation'];
  private readonly onAccepted: BossModeServiceOptions['onAccepted'];
  private readonly memory: AgentMemoryStore | undefined;
  private readonly memoryReviewer: BossModeServiceOptions['memoryReviewer'];
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
    this.bossModelReference = options.bossModelReference;
    this.workerCapabilityGrants = options.workerCapabilityGrants
      ?? (() => Object.freeze([]));
    this.conversation = options.conversation;
    this.onAccepted = options.onAccepted;
    this.memory = options.memory;
    this.memoryReviewer = options.memoryReviewer;
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
    const raw = isRecord(input) ? input : {};
    const progress = typeof raw.onProgress === 'function' ? raw.onProgress as BossModeSubmitInput['onProgress'] : undefined;
    const submission = validateSubmission({ ...raw, ...(progress ? { onProgress: progress } : {}) });
    const resolvedIntentId = intentId(submission.idempotencyKey);
    if (submission.source !== 'agent-chat') {
      this.recordIntentText(resolvedIntentId, submission.text);
    }
    const bodyDigest = digest(JSON.stringify([submission.text, resolvedIntentId]));
    const recorded = this.findRecordedIntent(resolvedIntentId, bodyDigest);
    if (recorded) return recorded;

    const snapshot = this.store.get();
    this.backfillReportTexts();
    const organizationFacts = buildBossOrganizationFacts({
      snapshot,
      intentTexts: this.intentTexts(),
      ...(this.store.reportTexts?.() ? { reportTexts: this.store.reportTexts!() } : {}),
      agentInstructions: (worker) => this.instructionsForRevision(worker.agentRevisionId),
      capabilities: runtimeCapabilityFacts(this.workerCapabilityGrants().map((grant) => grant.name)),
    });
    const parseInput = {
      intentId: resolvedIntentId,
      text: submission.text,
      expectedSequence: snapshot.events.length,
      snapshot,
      organizationFacts,
      ...(this.memoryIndex() ? { memoryIndex: this.memoryIndex()! } : {}),
      ...(submission.reasoningEffort ? { reasoningEffort: submission.reasoningEffort } : {}),
      ...(submission.conversation ? { conversation: submission.conversation } : {}),
      ...(submission.onProgress ? { onProgress: (progress: { state: 'streaming'; percent: number; previousText?: string }) => {
        submission.onProgress?.({
          state: 'streaming',
          percent: progress.percent,
          ...(progress.previousText !== undefined ? { previousText: progress.previousText } : {}),
        });
      } } : {}),
    };
    const modelReference = submission.modelOverride
      ? await this.resolveModelOverride(submission.modelOverride)
      : await this.resolveModelReference();
    const direct = await this.parser.parse({ ...parseInput, modelReference });
    if (submission.source === 'agent-chat' && direct.actions.length > 0) {
      this.recordIntentText(resolvedIntentId, submission.text);
    }
    if (direct.memory && direct.memory.length > 0) {
      await this.recordProposedMemory(direct.memory, {
        userText: submission.text,
        assistantReply: direct.relay ?? '',
        sourceIntentId: resolvedIntentId,
      });
    }
    if (submission.source === 'agent-chat' && direct.actions.length === 0) {
      const accepted: BossModeSubmitResult = Object.freeze({
        version: BOSS_MODE_SERVICE_VERSION,
        intentId: resolvedIntentId,
        state: 'accepted' as const,
        expectedSequence: snapshot.events.length,
        actions: Object.freeze([]),
        executions: Object.freeze([]),
        relays: Object.freeze([]),
        reply: direct.relay,
      });
      onAccepted?.(accepted);
      this.onAccepted?.(accepted);
      return accepted;
    }
    const parsed = direct.actions.length > 0
      ? await this.prepareParsedActions({ ...parseInput, modelReference }, modelReference, direct)
      : direct;
    if (parsed.actions.length > 0) {
      submission.onProgress?.({ state: 'organizing', percent: null });
    }
    const actions: OrganizationAction[] = [];
    const executions: BossModeExecution[] = [];
    const createdWorkers: WorkerExecutionRecord[] = [];
    // A single plan may list create_agent and start_worker for the same worker,
    // and `create_agent` already starts it. Track what this turn dispatched so a
    // duplicate step cannot start a second task — not even when the first task
    // finished so fast that it is already terminal by the time the next action
    // is applied.
    const dispatchedThisTurn = new Set<string>();
    let acceptedPublished = false;
    let sequence = snapshot.events.length;

    for (const parsedAction of parsed.actions) {
      const action = actionAt(parsedAction, sequence);
      sequence += 1;
      actions.push(action);
      try {
        await this.applyParsedAction(action, {
          modelReference,
          createdWorkers,
          executions,
          dispatchedThisTurn,
        });
      } catch (cause) {
        executions.push(Object.freeze({ action, status: 'failed' as const, detail: boundedError(cause) }));
      }
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
    let outcomes: readonly WorkerOutcome[] = Object.freeze([]);
    if (createdWorkers.length > 0 && this.waitForTasks) {
      outcomes = await this.collectWorkerOutcomes(createdWorkers);
    }
    const coordination = this.coordinator.reconcile();
    // The model wrote `parsed.relay` before any worker ran, so it can only
    // describe intent ("I prepared..."). Once real results exist, the reply
    // must report those instead of the pre-execution promise.
    const reply = outcomes.length > 0 ? this.composeOutcomeReply(outcomes) : parsed.relay;
    const result: BossModeSubmitResult = Object.freeze({
      version: BOSS_MODE_SERVICE_VERSION,
      intentId: resolvedIntentId,
      state: 'accepted' as const,
      expectedSequence: this.store.get().events.length,
      actions: Object.freeze(actions),
      executions: Object.freeze(executions),
      relays: coordination.relays,
      reply,
    });
    if (this.store.get().events.some((event) =>
      event.type === 'organization.intent_recorded' && event.data.intentId === resolvedIntentId) === false) {
      this.recordIntent(resolvedIntentId, bodyDigest, actions.length);
    }
    if (executions.length > 0 && executions.every((execution) => execution.status === 'failed')) {
      // Surface the first concrete reason. A summary that only says "failed"
      // forces the operator to go digging, and hides actionable causes such as
      // an inactive delegation or a closed project.
      const firstDetail = executions
        .map((execution) => execution.detail?.trim())
        .find((detail) => detail && detail.length > 0);
      const reason = firstDetail ? `: ${boundedError(firstDetail)}` : '';
      throw new BossModeServiceError(`Boss mode execution failed${reason}`);
    }
    return result;
  }

  private async applyParsedAction(
    action: OrganizationAction,
    context: {
      readonly modelReference: { readonly providerId: string; readonly modelId: string } | undefined;
      readonly createdWorkers: WorkerExecutionRecord[];
      readonly executions: BossModeExecution[];
      readonly dispatchedThisTurn: Set<string>;
    },
  ): Promise<void> {
    if (action.type === 'record_intent') {
      applyAction(this.store, action, action.projectId);
      return;
    }
    if (action.type === 'create_agent') {
      if (!context.modelReference) throw new BossModeServiceError('Worker model reference is unavailable.');
      const execution = await this.createDynamicAgent(action, context.modelReference);
      context.executions.push(execution);
      if (execution.status === 'created-agent') {
        const record = this.workerExecutions.get(action.workerId);
        if (record) context.createdWorkers.push(record);
        // `create_agent` also starts the worker, so a later explicit
        // `start_worker` in the same plan is a duplicate of this dispatch.
        context.dispatchedThisTurn.add(action.workerId);
      }
      return;
    }
    if (action.type === 'authorize_worker') {
      // Creating a dynamic Agent already authorizes its worker. A model that
      // also emits the explicit step is following the documented action list,
      // not making a mistake, so this is an idempotent skip rather than a
      // failure. Applying it again would hit "Worker is not proposed."
      const worker = this.store.get().workers.find((item) => item.id === action.workerId);
      if (worker && worker.state !== 'proposed') {
        context.executions.push(Object.freeze({
          action,
          status: 'skipped' as const,
          detail: `Worker is already ${worker.state}; the Runtime authorizes a worker when it is created.`,
        }));
        return;
      }
      applyAction(this.store, action);
      context.executions.push(Object.freeze({ action, status: 'dispatched' as const }));
      return;
    }
    if (action.type === 'start_worker') {
      if (!this.workerExecutions.has(action.workerId)) return;
      if (context.dispatchedThisTurn.has(action.workerId)) {
        context.executions.push(Object.freeze({
          action,
          status: 'skipped' as const,
          detail: 'Worker was already started earlier in this plan.',
        }));
        return;
      }
      // A worker that already started once must still be able to run again: the
      // Boss re-runs a worker by starting it, and skipping here silently drops
      // that request while the fresh task runs unobserved.
      if (this.startedWorkers.has(action.workerId)) {
        const latest = this.workerExecutions.get(action.workerId)!;
        const latestTask = this.taskService?.store.getTask(latest.taskId);
        if (latestTask && !['succeeded', 'failed', 'cancelled', 'interrupted'].includes(latestTask.state)) {
          context.executions.push(Object.freeze({
            action,
            status: 'skipped' as const,
            detail: `Worker already started; task ${latest.taskId} is still ${latestTask.state}.`,
          }));
          return;
        }
        this.startedWorkers.delete(action.workerId);
      }
      const worker = this.store.get().workers.find((item) => item.id === action.workerId);
      const mutated = Boolean(worker && ['authorized', 'idle'].includes(worker.state));
      if (mutated) applyAction(this.store, action);
      this.startedWorkers.add(action.workerId);
      const execution = this.ensureWorkItem(action);
      context.executions.push(execution);
      // A re-run dispatches a new task; it must be awaited like a fresh hire,
      // otherwise the Boss reports on the old result and never sees the new one.
      if (execution.status === 'dispatched') {
        const record = this.workerExecutions.get(action.workerId);
        if (record) context.createdWorkers.push(record);
        context.dispatchedThisTurn.add(action.workerId);
      }
      if (execution.status === 'skipped' && mutated) {
        // The worker was already marked running; leaving it there would strand a
        // "running" worker with no task. Report a failure so the UI sees the truth.
        const blocked = this.blockStartedWorker(action);
        if (blocked) {
          context.executions.push(Object.freeze({ action, status: 'failed' as const, detail: execution.detail ?? 'Worker could not start.' }));
        }
      }
      return;
    }
    if (action.type === 'quiet_project' || action.type === 'archive_project' || action.type === 'resume_project') {
      context.executions.push(await this.runLifecycleBatch(action));
      return;
    }
    if (action.type === 'offboard_worker') {
      applyAction(this.store, action);
      context.executions.push(Object.freeze({ action, status: 'dispatched' as const }));
      this.archiveWorkerAgent(action.workerId);
      return;
    }
    if (action.type === 'answer_attention' || action.type === 'withdraw_attention' || action.type === 'expire_attention') {
      context.executions.push(this.answerAttention(action as Extract<OrganizationAction, { type: 'answer_attention' }>));
      return;
    }
    if (action.type === 'resume_worker') {
      // Resuming a project already resumes its offboarded workers. A plan that
      // also lists the explicit step is not wrong, so treat it as an idempotent
      // skip instead of emitting a duplicate worker_resumed event.
      const worker = this.store.get().workers.find((item) => item.id === action.workerId);
      if (!worker || worker.state !== 'offboarded') {
        context.executions.push(Object.freeze({
          action,
          status: 'skipped' as const,
          detail: worker
            ? `Worker is already ${worker.state}; project resume restores its workers.`
            : 'Worker does not exist.',
        }));
        return;
      }
      applyAction(this.store, action);
      context.executions.push(Object.freeze({ action, status: 'dispatched' as const }));
      return;
    }
    applyAction(this.store, action);
    context.executions.push(Object.freeze({ action, status: 'dispatched' as const }));
  }

  get organizationStore(): OrganizationStore {
    return this.store;
  }

  getDynamicAgentRevisionId(workerId: string): string | undefined {
    return this.workerExecutions.get(workerId)?.agentRevisionId;
  }

  private intentTexts(): ReadonlyMap<string, string> {
    const persisted = this.store.intentTexts?.();
    if (persisted && persisted.size > 0) {
      const merged = new Map(persisted);
      for (const [key, value] of this.conversation?.intentTexts?.() ?? []) {
        if (!merged.has(key)) merged.set(key, value);
      }
      return merged;
    }
    if (typeof this.conversation?.intentTexts === 'function') return this.conversation.intentTexts();
    return new Map();
  }

  /**
   * The compact memory index injected into the Boss prompt.
   *
   * Runtime scope applies to every turn; project scope only to the projects
   * this conversation is currently working with. That keeps a fact learned in
   * one project from being asserted as a runtime-wide truth.
   */
  private memoryIndex(): string {
    const memory = this.memory;
    if (!memory) return '';
    try {
      const snapshot = this.store.get();
      const activeProjectIds = new Set(
        snapshot.projects
          .filter((project) => project.state === 'active' || project.state === 'resumed')
          .map((project) => project.id),
      );
      const entries = [
        ...memory.list({ scope: 'runtime', limit: MEMORY_LIMITS.injected }),
        ...snapshot.projects
          .filter((project) => activeProjectIds.has(project.id))
          .flatMap((project) => memory.list({ scope: 'project', scopeId: project.id, limit: 4 })),
      ];
      return renderMemoryIndex(entries);
    } catch {
      // Memory is an enhancement. A failure must never break a conversation.
      return '';
    }
  }

  /**
   * Persists memory the model proposed, after Runtime checks.
   *
   * The model supplies content; the Runtime supplies authority. An entry whose
   * scope target does not exist is dropped rather than stored as a dangling
   * fact, and a bad entry never fails the turn it arrived with.
   */
  private async recordProposedMemory(
    entries: readonly AgentMemoryInput[],
    context: { readonly userText: string; readonly assistantReply: string; readonly sourceIntentId: string },
  ): Promise<void> {
    const memory = this.memory;
    if (!memory) return;
    let snapshot: OrganizationSnapshot;
    try {
      snapshot = this.store.get();
    } catch {
      return;
    }
    // Runtime checks come first: a reviewer cannot resurrect an entry whose
    // scope target does not exist, and it never sees entries the Runtime has
    // already refused.
    const candidates = entries.filter((entry) => {
      if (entry.scope === 'runtime') {
        // A global fact needs an independent confirmation, not just a model's
        // proposal; without a reviewer this cannot be established, so drop it.
        return Boolean(this.memoryReviewer);
      }
      return entry.scope === 'project'
        ? snapshot.projects.some((project) => project.id === entry.scopeId)
        : snapshot.workers.some((worker) => worker.id === entry.scopeId);
    });
    if (candidates.length === 0) return;
    let accepted: readonly AgentMemoryInput[] = candidates;
    if (this.memoryReviewer) {
      let review: MemoryReviewResult | null = null;
      try {
        review = await this.memoryReviewer({
          userText: context.userText,
          assistantReply: context.assistantReply,
          // Existing titles, so the reviewer can spot a duplicate; the
          // candidates themselves are sent separately as `proposals`.
          existingTitles: [...new Set(candidates.flatMap((entry) => memory.list({
            scope: entry.scope,
            ...(entry.scopeId ? { scopeId: entry.scopeId } : {}),
            limit: 24,
          }).map((stored) => stored.title)))],
          proposals: candidates,
        });
      } catch {
        review = null;
      }
      if (!review) {
        // A reviewer is configured but unavailable. Writing unreviewed would
        // defeat the reason it exists, so the proposal is dropped. Memory is
        // advisory and the user can always ask again.
        return;
      }
      const verdicts = new Map(review.decisions.map((decision) => [decision.index, decision]));
      accepted = candidates.filter((entry, index) => {
        const verdict = verdicts.get(index);
        if (verdict?.verdict !== 'accept') return false;
        // A runtime-scope entry additionally needs the explicit confirmation,
        // so a plain "this is durable" cannot silently promote it to global.
        if (entry.scope === 'runtime' && verdict.runtimeScopeConfirmed !== true) return false;
        return true;
      });
    }
    for (const entry of accepted) {
      try {
        memory.write({
          ...entry,
          sourceIntentId: context.sourceIntentId,
          // A live, reviewed request may restore a retracted key; only the
          // automatic path is forbidden from doing so.
          origin: 'conversational',
          ...(this.memoryReviewer ? { reviewedBy: 'accepted' as const } : {}),
        });
      } catch {
        // Memory is advisory. A rejected write must not break the conversation.
      }
    }
  }

  private backfillReportTexts(): void {
    const taskService = this.taskService;
    const store = this.store;
    if (!taskService || typeof store.recordReportText !== 'function') return;
    const existing = store.reportTexts?.() ?? new Map<string, string>();
    const snapshot = store.get();
    const taskByWorker = new Map<string, string>();
    for (const event of snapshot.events) {
      if (event.type !== 'organization.worker_execution_recorded') continue;
      const workerId = typeof event.data.workerId === 'string' ? event.data.workerId : null;
      const taskId = typeof event.data.taskId === 'string' ? event.data.taskId : null;
      if (workerId && taskId) taskByWorker.set(workerId, taskId);
    }
    for (const report of snapshot.reports) {
      if (existing.has(report.id)) continue;
      const taskId = taskByWorker.get(report.workerId);
      if (!taskId) continue;
      const task = taskService.store.getTask(taskId);
      if (!task) continue;
      const output = task.state === 'succeeded' ? task.output ?? '' : task.error ?? '';
      if (output.length === 0) continue;
      try {
        store.recordReportText(report.id, output.slice(0, 4_000));
      } catch {
        return;
      }
    }
  }

  private recordIntentText(intentIdValue: string, text: string): void {
    try {
      this.store.recordIntentText?.(intentIdValue, text);
    } catch {
      // Persistence is best-effort; the in-process copy remains a fallback.
    }
    this.conversation?.recordIntentText(intentIdValue, text);
  }

  private instructionsForRevision(revisionId: string): string | undefined {
    const store = this.taskService?.store;
    if (!store) return undefined;
    for (const agent of store.listAgents()) {
      const revision = store.getAgentRevision(agent.id, revisionId);
      if (revision) return revision.instructions;
    }
    return undefined;
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
    // The Boss conversation has its own configured model (`CONCHBASE_BOSS_MODEL`
    // or the default model). Taking the first catalog entry instead would hand
    // the Boss a model the operator never chose, and would break whenever that
    // arbitrary entry is unavailable — which is exactly what happened in a live
    // probe: the first entry was a model whose quota was exhausted.
    const configured = this.bossModelReference;
    if (configured) return configured;

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

  private async resolveModelOverride(
    reference: { readonly providerId: string; readonly modelId: string },
  ): Promise<{ providerId: string; modelId: string }> {
    const taskService = this.taskService;
    if (!taskService) throw new BossModeServiceError('Task service is unavailable.');
    try {
      await taskService.validateModelReference(reference);
      return Object.freeze({ providerId: reference.providerId, modelId: reference.modelId });
    } catch (cause) {
      throw new BossModeServiceError(`Selected model is not available: ${boundedError(cause)}`);
    }
  }

  private async prepareParsedActions(
    parseInput: Parameters<OrganizationIntentParser['parse']>[0],
    modelReference: { providerId: string; modelId: string },
    parsedInput?: OrganizationIntentParseResult,
  ): Promise<OrganizationIntentParseResult> {
    const parsed = parsedInput ?? await this.parser.parse({ ...parseInput, modelReference });
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
        ? Object.freeze({
          ...candidate,
          model: isRecord(candidate.model) && typeof candidate.model.providerId === 'string'
            && typeof candidate.model.modelId === 'string'
            ? candidate.model
            : modelReference,
        })
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
      const instructions = action.instructions?.trim() || [
        `你是${displayName}。`,
        `Work only within project scope: ${action.scope.join(', ')}.`,
        'Return a concise bounded result. Prefix output with ATTENTION: only when human input is required.',
      ].join(' ');
      const agent = await taskService.createAgent({
        name: displayName,
        instructions,
        providerId: modelReference.providerId,
        modelId: modelReference.modelId,
        grantedCapabilities: this.workerCapabilityGrants(),
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
    const project = snapshot.projects.find((item) => item.id === action.projectId);
    const projectPurpose = project
      ? this.intentTexts().get(project.originTriggerId)?.slice(0, 600) ?? '未记录明确目标'
      : '项目记录缺失';
    const delegation = snapshot.delegations.find((item) => item.id === action.delegationId);
    const scope = (delegation?.scope ?? action.scope).join('、') || '未限定';
    const capabilities = (delegation?.capabilities ?? action.capabilities).join('、') || '仅读取上下文';
    const hasExplicitFormat = (action.instructions ?? '').trim().length > 0;
    const prompt = [
      `你是${chineseAgentDisplayName(action.displayName)}，为项目 ${action.projectId} 执行限定任务。`,
      `项目目标：${projectPurpose}`,
      `授权范围：${scope}`,
      `可用能力：${capabilities}${this.workerCanWrite() ? '、workspace_write（可写文件）' : ''}`,
      '组织结构（项目、员工、委派、汇报记录）只存在于 Runtime 里，不在工作区文件中，不要为找它们去翻文件。',
      ...(this.workerCanWrite()
        ? ['你可以读写工作区：需要文件内容时用读取工具，需要产出文件时用 workspace_write 直接写入。任务要求交付文件时，必须真的写出来，不要只描述方案。']
        : ['项目数据在工作区：需要文件内容、目录列表或匹配项时，用可用的读取工具取得。']),
      '具体事实（数字、文件名、路径）必须来自工具结果；取不到就说明原因，不要推测。',
      '不要用相同参数重复调用同一个工具。',
      '请直接基于上述上下文给出简洁结论，通常一轮即可完成。',
      ...(hasExplicitFormat
        ? ['严格按系统指令中的输出格式作答；系统指令禁止的内容不得输出，包括 ATTENTION 行。']
        : ['需要人工输入时以 ATTENTION: 开头。']),
    ].join('\n');
    const task = taskService.store.createAgentTask({
      // Task ids must be unique, not derived. The previous deterministic id
      // collided when the same worker was dispatched at the same event count,
      // which silently reused an existing task instead of creating a new one.
      id: `task_${randomUUID()}`,
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

  // Offboarding a worker revokes its delegation; the Agent revision it used has no
  // further purpose, so archive it instead of leaving it in the Agent list forever.
  private archiveWorkerAgent(workerId: string): void {
    const store = this.taskService?.store;
    if (!store) return;
    const record = this.workerExecutions.get(workerId);
    if (!record) return;
    try {
      const agent = store.getAgent(record.agentId);
      if (!agent || agent.archived) return;
      store.archiveAgent(record.agentId);
    } catch {
      // Archiving is best-effort; the offboard itself already succeeded.
    }
    // Keep the execution record: resume needs the Agent and revision ids to
    // recreate a usable Agent. Deleting it here was why a resumed worker came
    // back with no Agent at all. `startedWorkers` is still cleared so a resume
    // is allowed to dispatch again.
    this.startedWorkers.delete(workerId);
  }

  private blockStartedWorker(action: Extract<OrganizationAction, { type: 'start_worker' }>): boolean {
    const worker = this.store.get().workers.find((item) => item.id === action.workerId);
    if (!worker || worker.state !== 'running') return false;
    try {
      applyAction(this.store, {
        type: 'report_worker',
        expectedSequence: this.store.get().events.length,
        projectId: action.projectId,
        workerId: action.workerId,
        reportId: `rpt_${reference(`${action.workerId}:start-blocked:${this.store.get().events.length}`)}`,
        state: 'failed',
        summaryDigest: digest(`start-blocked:${action.workerId}`),
      });
      this.startedWorkers.delete(action.workerId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Returns a fresh binding when the recorded WorkItem is already terminal.
   * A terminal WorkItem cannot be started again, so replaying it would fail
   * instead of running the work.
   */
  private rebindIfTerminal(
    record: WorkerExecutionRecord,
    projectId: string,
  ): WorkerExecutionRecord | null {
    const platform = this.taskService?.store.platform;
    if (!platform) return null;
    let state: string;
    try {
      state = platform.getWorkItemDetail(record.workItemId).workItem.state;
    } catch {
      return null;
    }
    if (state === 'open' || state === 'paused') return null;
    this.rebindResumedWorker(record.workerId, projectId);
    return this.workerExecutions.get(record.workerId) ?? null;
  }

  /**
   * Binds a resumed worker to a new task and WorkItem. The previous execution
   * belongs to a terminal WorkItem, so the only correct way to run the work
   * again is a fresh binding rather than replaying the old one.
   */
  private rebindResumedWorker(workerId: string, projectId: string): void {
    const taskService = this.taskService;
    const record = this.workerExecutions.get(workerId);
    if (!taskService || !record) return;
    const previous = taskService.store.getTask(record.taskId);
    if (!previous) return;
    // Use the current binding, not the previous task's Agent: offboard archived
    // that Agent and resume replaced it with a fresh one. Reusing the archived
    // id fails with "Archived Agents cannot start new tasks".
    const task = taskService.store.createAgentTask({
      id: `task_${reference(`${workerId}:resume:${this.store.get().events.length}`)}`,
      prompt: previous.prompt,
      agentId: record.agentId,
      expectedAgentRevisionId: record.agentRevisionId,
    });
    const stableKey = `${projectId}:${workerId}:resume:${this.store.get().events.length}`;
    const envelope = taskService.store.work.ingestWorkTrigger({
      source: { sourceId: 'boss-mode', kind: 'fake' },
      trigger: {
        triggerId: `boss_${reference(stableKey)}`,
        threadKey: `boss:${stableKey}`,
        payloadDigest: digest(stableKey),
        occurredAt: this.now(),
      },
      mandate: {
        scope: ['project:' + projectId],
        allowedOperations: ['observe'],
        capabilitiesDigest: digest(`capabilities:${stableKey}`),
      },
      model: { providerId: previous.providerId ?? 'magpie', modelId: previous.modelId ?? previous.model },
      agentRevisionId: task.agentRevisionId!,
      configurationRevisionId: task.configurationRevisionId,
    });
    this.workerExecutions.set(workerId, Object.freeze({
      ...record,
      taskId: task.id,
      workItemId: envelope.workItem.id,
    }));
    // Starting is the caller's job: `ensureWorkItem` starts the task after it
    // opens the WorkItem, and starting here would make that second start fail
    // with "Task is not queued".
  }

  /**
   * Recreates a usable Agent for a resumed worker.
   *
   * Offboarding archives the Agent, and an archived Agent cannot back a task.
   * The recorded revision is the authority for what this worker was allowed to
   * do, so the replacement is built from it rather than from a model guess.
   * Returns false when the revision is no longer available; the caller then
   * reports the resume as incomplete instead of starting work that must fail.
   */
  private async recreateResumedAgent(workerId: string): Promise<boolean> {
    const taskService = this.taskService;
    const record = this.workerExecutions.get(workerId);
    if (!taskService || !record) return false;
    const revision = taskService.store.getAgentRevision(record.agentId, record.agentRevisionId);
    if (!revision) return false;
    const worker = this.store.get().workers.find((item) => item.id === workerId);
    try {
      const agent = await taskService.createAgent({
        name: worker?.displayName ?? revision.name,
        instructions: revision.instructions,
        providerId: revision.providerId,
        modelId: revision.modelId,
        grantedCapabilities: revision.grantedCapabilities,
      });
      this.workerExecutions.set(workerId, Object.freeze({
        ...record,
        agentId: agent.id,
        // The recreated Agent owns a new revision id. Keeping the old one makes
        // createAgentTask reject the task with "Agent revision changed".
        agentRevisionId: agent.currentRevisionId,
      }));
      return true;
    } catch {
      return false;
    }
  }

  /** Whether the grants handed to dynamically hired workers include a write tool. */
  private workerCanWrite(): boolean {
    return this.workerCapabilityGrants().some((grant) =>
      grant.kind === 'tool' && grant.name === 'workspace_write');
  }

  private ensureWorkItem(action: Extract<OrganizationAction, { type: 'start_worker' }>): BossModeExecution {
    const record = this.workerExecutions.get(action.workerId);
    if (!record) return Object.freeze({ action, status: 'skipped' as const, detail: 'No validated Agent revision.' });
    const platform = this.taskService?.store.platform;
    if (!platform) return Object.freeze({ action, status: 'failed' as const, detail: 'Platform store is unavailable.' });
    const snapshot = this.store.get();
    const blocking = snapshot.attentionRequests.find((request) =>
      request.state === 'open' && request.projectId === action.projectId);
    if (blocking) {
      return Object.freeze({
        action,
        status: 'skipped' as const,
        detail: `Open attention ${blocking.id} in this project blocks new work until it is answered or withdrawn.`,
      });
    }
    try {
      // A worker that already ran has a terminal WorkItem. Starting it again
      // must bind a fresh WorkItem and task instead of replaying a finished one.
      const rebound = this.rebindIfTerminal(record, action.projectId);
      if (rebound) {
        platform.startWork(rebound.workItemId, 'open');
        this.taskService?.startTask(rebound.taskId);
        return Object.freeze({ action, status: 'dispatched' as const });
      }
      platform.startWork(record.workItemId, 'open');
      this.taskService?.startTask(record.taskId);
      return Object.freeze({ action, status: 'dispatched' as const });
    } catch (cause) {
      return Object.freeze({ action, status: 'failed' as const, detail: boundedError(cause) });
    }
  }

  // A worker that fails twice is retired instead of retried forever. This keeps the
  // project from accumulating stuck workers and stops the "hire a near-identical
  // replacement" loop that the Boss used to fall into.
  private autoRetireFailingWorker(record: WorkerExecutionRecord, output: string): void {
    if (/HTTP\s*(401|402|403|429)|quota|billing/i.test(output)) return;
    const snapshot = this.store.get();
    const worker = snapshot.workers.find((item) => item.id === record.workerId);
    if (!worker || worker.state === 'offboarded' || worker.state === 'ended') return;
    const failures = snapshot.reports.filter((report) =>
      report.workerId === record.workerId && report.state === 'failed').length;
    if (failures < 2) return;
    try {
      applyAction(this.store, {
        type: 'offboard_worker',
        expectedSequence: snapshot.events.length,
        projectId: record.projectId,
        workerId: record.workerId,
      });
    } catch {
      // Retirement is best-effort; a rejected offboard must not break the report.
    }
  }

  private async collectWorkerOutcomes(
    records: readonly WorkerExecutionRecord[],
  ): Promise<readonly WorkerOutcome[]> {
    const taskService = this.taskService;
    if (!taskService) return Object.freeze([]);
    const outcomes: WorkerOutcome[] = [];
    for (const record of records) {
      let task = taskService.store.getTask(record.taskId);
      if (!task) continue;
      let missing = false;
      while (!['succeeded', 'failed', 'cancelled', 'interrupted'].includes(task.state)) {
        await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
        const next = taskService.store.getTask(record.taskId);
        if (!next) {
          missing = true;
          break;
        }
        task = next;
      }
      // A task that disappeared mid-wait has no outcome to report.
      if (missing) continue;
      const terminalState = task.state as WorkerOutcome['taskState'];
      const output = task.state === 'succeeded' ? task.output ?? '' : task.error ?? task.state;
      outcomes.push(Object.freeze({
        workerId: record.workerId,
        displayName: this.store.get().workers.find((worker) => worker.id === record.workerId)?.displayName
          ?? record.workerId,
        taskState: terminalState,
        body: output,
      }));
      // A re-run binds a fresh task, so both the report id and the wait must be
      // keyed by task. An already-recorded outcome is still returned so a
      // repeated submit can restate the result instead of dropping it.
      const previous = this.outcomeByTaskId.get(record.taskId);
      if (previous) continue;
      const summaryDigest = digest(`${record.taskId}:${task.state}:${output}`);
      const reportId = `rpt_${reference(`${record.taskId}:report`)}`;
      try {
        this.store.recordReportText?.(reportId, output.slice(0, 4_000));
      } catch {
        // Report text is best-effort; the digest remains authoritative for the ledger.
      }
      const needsAttention = /(?:^|\n)\s*ATTENTION:/i.test(output);
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
      if (!needsAttention && task.state !== 'succeeded') {
        this.autoRetireFailingWorker(record, output);
      }
      try {
        if (taskService.store.platform.getWorkItemDetail(record.workItemId).workItem.state === 'running') {
          taskService.store.platform.completeWork(record.workItemId, 'running');
        }
      } catch {
        // The report is already durable; a missing WorkItem must not discard it.
      }
    }
    return Object.freeze(outcomes);
  }

  /**
   * Builds the final Boss reply from what workers actually returned. The
   * pre-execution model relay is intentionally not reused: it was written
   * before the work ran, so it cannot state a result.
   */
  private composeOutcomeReply(outcomes: readonly WorkerOutcome[]): string {
    const succeeded = outcomes.filter((outcome) => outcome.taskState === 'succeeded').length;
    const body = outcomes.map((outcome) => {
      const state = outcome.taskState === 'succeeded' ? '已完成' : outcome.taskState === 'cancelled'
        ? '已取消'
        : outcome.taskState === 'interrupted' ? '已中断' : '失败';
      const text = outcome.body.trim().length > 0
        ? outcome.body.trim().slice(0, 1_200)
        : '（员工没有返回正文）';
      return `- ${outcome.displayName}（${outcome.workerId}）· ${state}\n${text}`;
    });
    const composed = [
      `员工执行完成：${outcomes.length} 名中 ${succeeded} 名成功。`,
      ...body,
    ].join('\n\n');
    // Worker output is untrusted model output. It must not smuggle a secret-like
    // value into the Boss reply, and the reply stays within the published bound.
    if (containsSecretLike(composed)) {
      return `员工执行完成：${outcomes.length} 名中 ${succeeded} 名成功。汇报正文包含疑似敏感内容，已隐藏。`;
    }
    return composed.slice(0, 11_500);
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

  private async runLifecycleBatch(action: OrganizationAction): Promise<BossModeExecution> {
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
          // Same rule as an explicit offboard: the Agent revision this worker
          // used is archived, so the Agent list does not accumulate one Agent
          // per closed project. Resume recreates a usable Agent from the
          // recorded revision.
          this.archiveWorkerAgent(worker.id);
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
        // Offboarding archived the Agent, and an archived Agent cannot run a
        // task. Resume therefore recreates one from the revision recorded for
        // this worker, keeping the original instructions and grants.
        const restored = await this.recreateResumedAgent(worker.id);
        if (!restored) {
          return Object.freeze({
            action,
            status: 'failed' as const,
            detail: `Worker ${worker.id} resumed without a usable Agent revision; the Agent was archived at offboard and could not be recreated.`,
          });
        }
        // A resumed worker needs a fresh execution binding: its previous
        // WorkItem is already terminal, so reusing it fails the start
        // transition instead of running the work.
        this.rebindResumedWorker(worker.id, project.id);
        const fresh = this.workerExecutions.get(worker.id);
        if (fresh) {
          // The project-resume path starts the work itself; the start_worker
          // path does it after opening the WorkItem.
          this.taskService?.store.platform.startWork(fresh.workItemId, 'open');
          this.taskService?.startTask(fresh.taskId);
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
