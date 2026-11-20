import { randomUUID } from 'node:crypto';
import {
  ConfigurationValidationError,
  isConfigurationDocumentV2,
  parseConfigurationDocument,
  type ConfigurationDocument,
  type ConfigurationDocumentV2,
  type ConfigurationRevision,
} from './configuration-document.js';
import {
  compositionOutput,
  planCompositionExecution,
  type CompositionExecutionPlan,
} from './composition-execution.js';
import {
  MagpieModelCatalog,
  type ModelCatalogClient,
  type ModelCatalogEntry,
} from './model-catalog.js';
import { OpenAiChatCompletionsProvider } from './magpie-provider.js';
import { ReadResultCache } from './read-result-cache.js';
import { resolveTaskCapabilities, type TaskCapabilities } from './task-capabilities.js';
import { decideToolAction, resolveLevel } from './tool-gate.js';
import {
  defaultProviderId,
  isSupportedProvider,
  listProviders,
  resolveProviderEndpoint,
  unconfiguredProviderMessage,
  unsupportedProviderMessage,
  type ProviderEndpoint,
} from './provider-registry.js';
import { drainToolCalls as drainToolCallsImpl, type AgentLoopToolContext } from './agent-loop-tools.js';
import { digestArguments } from './tool-arguments.js';
import { buildToolRequestPreview } from './tool-request-preview.js';
import { projectSkills, projectToolProvider } from './capability-grants.js';
import type { ExecutionMode, LoopBudget } from '../config/runtime-config.js';
import type { PermissionLevel } from '../kernel/policy.js';
import {
  OTEL_GENAI_ATTRIBUTES,
  flattenOtelAttributes,
  otelGenAiAttributes,
} from './otel-genai.js';
import {
  AgentConflictError,
  AgentNotFoundError,
  AgentValidationError,
  parseAgentProfile,
  type AgentDetail,
  type AgentProfileInput,
  type AgentRecord,
  type AgentRevision,
  type ModelReference,
} from './agent-profile.js';
import { isTerminalTaskState, type TaskEventType } from './task-lifecycle.js';
import {
  ConfigurationRevisionNotFoundError as StoreRevisionNotFoundError,
  SqliteTaskStore,
  TaskConflictError,
  TaskNotFoundError,
  type ApplyConfigurationResult,
  type ConfigurationState,
  type TaskSnapshot,
  type TaskStore,
} from './task-store.js';
import {
  ToolRequestContextError,
  ToolRequestConflictError,
  ToolRequestNotFoundError,
  ToolRequestValidationError,
  parseToolRequestDecision,
  parseToolRequestInput,
  toolApprovalId,
  toolRequestId,
  toolRequestIdentity,
  toolRequestIdempotencyKey,
  type ToolRequestRecord,
} from './tool-request.js';
import { createBuiltinReadTools, ToolRejectedError, type ToolProvider } from './tool-provider.js';
import { categorizeError } from './error-categories.js';
import type { ProviderMessage } from './model-adapter.js';
import type { ProviderToolCall } from './model-adapter.js';

export interface TaskServiceConfig {
  readonly magpieBaseUrl: string;
  readonly magpieAppKey?: string;
  /**
   * Endpoints for the non-default providers. A provider listed in the registry
   * without an entry here is not reachable; it must not silently reuse Magpie.
   */
  readonly providers?: Readonly<Record<string, { readonly baseUrl: string; readonly appKey?: string }>>;
  readonly defaultModel: string;
  readonly fetch?: typeof globalThis.fetch;
  /**
   * `restricted` pauses consequential tool calls for approval;
   * `unrestricted` executes every granted tool immediately.
   */
  readonly executionMode?: ExecutionMode;
  /**
   * The resolved permission level. When absent, the level is derived from
   * `executionMode` so existing callers keep their current behaviour.
   */
  readonly permissionLevel?: PermissionLevel;
  /**
   * Operator-set Agent loop ceilings. Resolved once at process start
   * and never influenced by a task, client, Agent revision, or model.
   */
  readonly loopBudget?: LoopBudget;
  /**
   * How many tasks may hold a provider call at once.
   *
   * Without a bound, starting a burst — the common case after a restart, when
   * every queued task is re-admitted — opens one completion stream per task and
   * can exhaust the gateway. Admission is internal: a task waiting for a slot
   * is still `queued` and still cancellable.
   */
  readonly maxConcurrentTasks?: number;
}

export interface AgentLoopOptions {
  readonly tools?: ToolProvider;
  readonly reasoningEffort?: 'low' | 'medium' | 'high';
  readonly preferredChatModelId?: string;
  readonly skills?: readonly { readonly name: string; readonly instructions: string }[];
}

const DEFAULT_LOOP_BUDGET: LoopBudget = Object.freeze({
  maxIterations: 6,
  maxToolCallsPerTurn: 4,
  deadlineMs: 120_000,
});

const DEFAULT_MAX_CONCURRENT_TASKS = 4;

interface LoopContinuationCheckpoint {
  readonly version: 1;
  readonly iteration: number;
  readonly messages: ProviderMessage[];
}

function parseLoopContinuation(raw: string | null): LoopContinuationCheckpoint | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const candidate = parsed as Partial<LoopContinuationCheckpoint>;
  if (candidate.version !== 1) return undefined;
  if (!Number.isInteger(candidate.iteration) || (candidate.iteration ?? -1) < 0) return undefined;
  if (!Array.isArray(candidate.messages)) return undefined;
  return {
    version: 1,
    iteration: candidate.iteration as number,
    messages: candidate.messages as ProviderMessage[],
  };
}

export interface CreateTaskInput {
  readonly prompt: string;
  readonly model?: string;
}

export interface ProviderModelCatalogEntry extends ModelReference {
  readonly reference: string;
  readonly displayName: string;
  readonly capabilities: readonly string[];
}

export class TaskValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskValidationError';
  }
}

export {
  AgentConflictError,
  AgentNotFoundError,
  AgentValidationError,
  ConfigurationValidationError,
  StoreRevisionNotFoundError as ConfigurationRevisionNotFoundError,
  ToolRequestContextError,
  ToolRequestConflictError,
  ToolRequestNotFoundError,
  ToolRequestValidationError,
};

function validatePrompt(prompt: unknown): string {
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new TaskValidationError('prompt must be a non-empty string.');
  }
  if (prompt.length > 20_000) {
    throw new TaskValidationError('prompt must not exceed 20000 characters.');
  }
  return prompt;
}

export function createTaskService(
  filename: string,
  config: TaskServiceConfig,
  loopOptions?: AgentLoopOptions,
): TaskService {
  const store = new SqliteTaskStore(filename);
  const catalog = new MagpieModelCatalog({
    baseUrl: config.magpieBaseUrl,
    ...(config.magpieAppKey ? { appKey: config.magpieAppKey } : {}),
    ...(config.fetch ? { fetch: config.fetch } : {}),
  });
  return new TaskService(store, config, catalog, loopOptions);
}

export class TaskService {
  readonly store: TaskStore;
  private readonly eventListeners = new Set<(taskId: string) => void>();
  private readonly active = new Map<string, AbortController>();
  private readonly inFlight = new Set<Promise<void>>();
  private stopping = false;
  private readonly config: TaskServiceConfig;
  private readonly catalog: ModelCatalogClient;
  private readonly loopOptions: AgentLoopOptions;
  private readonly effortByTaskId = new Map<string, 'low' | 'medium' | 'high'>();
  private readonly sliceBudgetByTaskId = new Map<string, number>();
  /**
   * Bounded, renderable previews computed when a tool request is created.
   * Never persisted: the arguments exist only at request time, and a preview is
   * derived data that must not drift from (or leak into) durable state.
   */
  private readonly toolRequestPreviews = new Map<string, import('./tool-request-preview.js').ToolRequestPreview>();
  private readonly readResults = new ReadResultCache();
  /** Tasks currently holding an admission slot. */
  private readonly admitted = new Set<string>();
  /** Tasks waiting for a slot, in arrival order. */
  private readonly admissionWaiters: { taskId: string; grant: () => void }[] = [];
  private readonly maxConcurrentTasks: number;

  constructor(
    store: TaskStore,
    config: TaskServiceConfig,
    catalog?: ModelCatalogClient,
    loopOptions: AgentLoopOptions = {},
  ) {
    this.store = store;
    this.config = config;
    this.loopOptions = loopOptions;
    this.maxConcurrentTasks = Math.max(
      1,
      Math.min(32, config.maxConcurrentTasks ?? DEFAULT_MAX_CONCURRENT_TASKS),
    );
    this.catalog = catalog ?? new MagpieModelCatalog({
      baseUrl: config.magpieBaseUrl,
      ...(config.magpieAppKey ? { appKey: config.magpieAppKey } : {}),
      ...(config.fetch ? { fetch: config.fetch } : {}),
    });
    const resumable = this.interruptIncompleteTasks();
    this.store.platform.recoverAssignments();
    for (const taskId of resumable) this.startTask(taskId);
  }

  get activeConfigurationRevisionId(): string {
    return this.getConfigurationState().active.id;
  }

  get preferredChatModelId(): string | undefined {
    return this.loopOptions.preferredChatModelId ?? (this.config.defaultModel || undefined);
  }

  /** Names of currently registered tools and Skills; used by audit views only. */
  get availableCapabilityNames(): {
    readonly tools: readonly string[];
    readonly skills: readonly string[];
  } {
    return Object.freeze({
      tools: Object.freeze(this.loopOptions.tools?.list().map((tool) => tool.id) ?? []),
      skills: Object.freeze(this.loopOptions.skills?.map((skill) => skill.name) ?? []),
    });
  }

  get executionMode(): ExecutionMode {
    return this.config.executionMode ?? 'restricted';
  }

  get loopBudget(): LoopBudget {
    return this.config.loopBudget ?? DEFAULT_LOOP_BUDGET;
  }

  /**
   * The kernel decides; this only supplies the facts it needs.
   *
   * A tool reaching the loop is already inside the Agent's pinned grant set
   * (`resolveTaskCapabilities` projects the provider), so `granted` is true
   * here. The kernel still owns the approval rule, which keeps one answer to
   * "does this need a person" for every entry point.
   */
  private requiresApproval(definition: { readonly id?: string; readonly sideEffect: string }): boolean {
    return decideToolAction({
      level: resolveLevel(this.config.permissionLevel, this.executionMode),
      action: definition.id ?? 'tool',
      sideEffect: definition.sideEffect,
      granted: true,
    }).requiresApproval;
  }

  getConfigurationState(): ConfigurationState {
    return this.store.getConfigurationState();
  }

  getConfigurationRevision(id: string): ConfigurationRevision {
    const revision = this.store.getConfigurationRevision(id);
    if (!revision) throw new StoreRevisionNotFoundError();
    return revision;
  }

  validateConfiguration(input: unknown): ConfigurationDocument {
    return parseConfigurationDocument(input);
  }

  createToolRequest(input: unknown): {
    readonly request: ToolRequestRecord;
    readonly created: boolean;
  } {
    const proposal = parseToolRequestInput(input);
    const task = this.store.getTask(proposal.taskId);
    if (!task) throw new TaskNotFoundError();
    if (task.attempt !== proposal.attempt) {
      throw new ToolRequestContextError('Tool request attempt does not match the task.');
    }
    if (!['queued', 'running', 'waiting_approval'].includes(task.state)) {
      throw new ToolRequestContextError('Tool request task is not eligible.');
    }
    const revision = this.store.getConfigurationRevision(task.configurationRevisionId);
    if (!revision || revision.document.schemaVersion !== 2) {
      throw new ToolRequestContextError('Tool requests require a schemaVersion 2 task.');
    }
    const plan = planCompositionExecution(revision.document);
    const identity = toolRequestIdentity(
      proposal,
      plan,
      revision.id,
    );
    const idempotencyKey = toolRequestIdempotencyKey({
      taskId: task.id,
      attempt: task.attempt,
      configurationRevisionId: identity.configurationRevisionId,
      compositionDocumentId: identity.compositionDocumentId,
      compositionNodeId: identity.compositionNodeId,
      toolName: identity.toolName,
      argumentsDigest: identity.argumentsDigest,
    });
    const requestId = toolRequestId(idempotencyKey);
    const createdAt = new Date().toISOString();
    const baseData = {
      toolRequestId: requestId,
      configurationRevisionId: identity.configurationRevisionId,
      attempt: task.attempt,
      compositionDocumentId: identity.compositionDocumentId,
      compositionNodeId: identity.compositionNodeId,
      toolName: identity.toolName,
      argumentsDigest: identity.argumentsDigest,
      idempotencyKey,
      status: 'pending',
    };
    const result = this.store.createToolRequest({
      id: requestId,
      taskId: task.id,
      attempt: task.attempt,
      configurationRevisionId: task.configurationRevisionId,
      compositionDocumentId: identity.compositionDocumentId,
      compositionNodeId: identity.compositionNodeId,
      toolName: identity.toolName,
      argumentsDigest: identity.argumentsDigest,
      idempotencyKey,
      createdAt,
      requestedEvent: this.toolLedgerEvent(
        task,
        'tool.requested',
        baseData,
      ),
      approvalRequiredEvent: this.toolLedgerEvent(
        task,
        'tool.approval_required',
        baseData,
      ),
    });
    // Compute a preview from the arguments the caller just supplied, and keep
    // it in memory for the read path. A read tool, an out-of-workspace path, or
    // secret-like content yields no preview rather than an unsafe one.
    const preview = buildToolRequestPreview({
      toolName: identity.toolName,
      arguments: proposal.toolCall.arguments as Readonly<Record<string, unknown>>,
      // Infer create-vs-modify from the explicit overwrite flag rather than
      // reading the target: the Runtime must not widen its own read surface to
      // build a preview.
      existing: proposal.toolCall.arguments.overwrite === true ? '' : null,
    });
    if (preview) this.toolRequestPreviews.set(requestId, preview);
    const withPreview = preview ? Object.freeze({ ...result.record, preview }) : result.record;
    return Object.freeze({ request: withPreview, created: result.created });
  }

  getToolRequest(requestId: string): ToolRequestRecord {
    const request = this.store.getToolRequest(requestId);
    if (!request) throw new ToolRequestNotFoundError();
    const preview = this.toolRequestPreviews.get(requestId);
    return preview ? Object.freeze({ ...request, preview }) : request;
  }

  decideToolRequest(requestId: string, input: unknown): {
    readonly request: ToolRequestRecord;
    readonly changed: boolean;
  } {
    const decision = parseToolRequestDecision(input);
    const existing = this.store.getToolRequest(requestId);
    if (!existing) throw new ToolRequestNotFoundError();
    const task = this.store.getTask(existing.taskId);
    if (!task) throw new TaskNotFoundError();
    const approvalId = toolApprovalId(requestId, decision.decision, decision.reasonDigest);
    const decidedAt = new Date().toISOString();
    const event = this.toolLedgerEvent(task, decision.decision === 'approved'
      ? 'tool.approved'
      : 'tool.rejected', {
      toolRequestId: requestId,
      configurationRevisionId: existing.configurationRevisionId,
      attempt: existing.attempt,
      compositionDocumentId: existing.compositionDocumentId,
      compositionNodeId: existing.compositionNodeId,
      toolName: existing.toolName,
      argumentsDigest: existing.argumentsDigest,
      idempotencyKey: existing.idempotencyKey,
      status: decision.decision,
      decision: decision.decision,
      approvalId,
      reasonDigest: decision.reasonDigest,
    });
    const result = this.store.decideToolRequest(requestId, {
      approvalId,
      decision: decision.decision,
      reasonDigest: decision.reasonDigest,
      decidedAt,
      event,
    });
    return Object.freeze({ request: result.record, changed: result.changed });
  }

  applyConfiguration(input: unknown): ApplyConfigurationResult {
    if (typeof input !== 'object'
      || input === null
      || Array.isArray(input)
      || Object.keys(input).length !== 1) {
      throw new ConfigurationValidationError([
        { path: '$', reason: 'must contain exactly one of document or rollbackTo' },
      ]);
    }
    const request = input as Record<string, unknown>;
    if ('document' in request) {
      return this.store.applyConfiguration(parseConfigurationDocument(request.document));
    }
    if (typeof request.rollbackTo !== 'string') {
      throw new ConfigurationValidationError([
        { path: 'rollbackTo', reason: 'must be a revision id' },
      ]);
    }
    return this.store.rollbackConfiguration(request.rollbackTo);
  }

  createTask(body: unknown): TaskSnapshot {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new TaskValidationError('Request body must be an object.');
    }
    const request = body as Record<string, unknown>;
    const prompt = validatePrompt(request.prompt);
    const model = request.model === undefined
      ? this.config.defaultModel
      : request.model;
    if (typeof model !== 'string' || model.trim().length === 0 || model.length > 300) {
      throw new TaskValidationError('model must be a non-empty string of at most 300 characters.');
    }

    return this.store.createTask({
      id: `task_${randomUUID()}`,
      prompt,
      model,
      configurationRevisionId: this.getConfigurationState().active.id,
      attempt: 1,
    });
  }

  async createAgent(input: unknown): Promise<AgentDetail> {
    const profile = await this.validateAgentProfile(input);
    return this.store.createAgent(profile);
  }

  async updateAgent(agentId: string, input: unknown): Promise<AgentDetail> {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new AgentValidationError('Request body must be an object.');
    }
    const value = input as Record<string, unknown>;
    if (typeof value.expectedRevisionId !== 'string') {
      throw new AgentValidationError('expectedRevisionId is required.');
    }
    const profile = await this.validateAgentProfile(value.profile);
    return this.store.updateAgent(agentId, value.expectedRevisionId, profile);
  }

  async duplicateAgent(agentId: string, input: unknown): Promise<AgentDetail> {
    const request = typeof input === 'object' && input !== null && !Array.isArray(input)
      ? input as Record<string, unknown>
      : {};
    const source = this.store.getAgent(agentId);
    if (!source) throw new AgentNotFoundError();
    const revisionId = request.revisionId === undefined ? source.currentRevisionId : request.revisionId;
    if (typeof revisionId !== 'string') throw new AgentValidationError('revisionId must be a string.');
    const profile = request.profile === undefined
      ? undefined
      : await this.validateAgentProfile(request.profile);
    return this.store.duplicateAgent(agentId, revisionId, profile);
  }

  async createAgentTaskWithEffort(
    input: unknown,
    reasoningEffort?: 'low' | 'medium' | 'high',
  ): Promise<TaskSnapshot> {
    const task = await this.createAgentTask(input);
    if (reasoningEffort) this.effortByTaskId.set(task.id, reasoningEffort);
    return task;
  }

  async createAgentTask(input: unknown): Promise<TaskSnapshot> {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new TaskValidationError('Request body must be an object.');
    }
    const request = input as Record<string, unknown>;
    if ('model' in request) {
      throw new TaskValidationError('Agent-backed tasks use modelOverride instead of model.');
    }
    const prompt = validatePrompt(request.prompt);
    if (typeof request.agentId !== 'string' || request.agentId.length === 0) {
      throw new TaskValidationError('agentId is required.');
    }
    let modelOverride: ModelReference | undefined;
    if (request.modelOverride !== undefined) {
      const value = request.modelOverride;
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new TaskValidationError('modelOverride must contain providerId and modelId.');
      }
      const parsed = value as Record<string, unknown>;
      if (typeof parsed.providerId !== 'string' || typeof parsed.modelId !== 'string') {
        throw new TaskValidationError('modelOverride must contain providerId and modelId.');
      }
      modelOverride = { providerId: parsed.providerId, modelId: parsed.modelId };
    }
    const agent = this.store.getAgent(request.agentId);
    if (!agent) throw new AgentNotFoundError();
    if (agent.archived) throw new AgentConflictError('Archived Agents cannot start new tasks.');
    await this.validateModelReference(modelOverride ?? {
      providerId: agent.current.providerId,
      modelId: agent.current.modelId,
    });
    return this.store.createAgentTask({
      id: `task_${randomUUID()}`,
      prompt,
      agentId: request.agentId,
      expectedAgentRevisionId: agent.currentRevisionId,
      ...(modelOverride ? { modelOverride } : {}),
    });
  }

  async createTaskAndWait(body: unknown, signal?: AbortSignal): Promise<TaskSnapshot> {
    const task = this.createTask(body);
    this.startTask(task.id);
    return this.waitForTask(task.id, signal);
  }

  waitForTask(taskId: string, signal?: AbortSignal): Promise<TaskSnapshot> {
    return new Promise<TaskSnapshot>((resolve, reject) => {
      const poll = () => {
        const task = this.store.getTask(taskId);
        if (!task) {
          reject(new TaskNotFoundError());
          return;
        }
        if (isTerminalTaskState(task.state)) {
          resolve(task);
          return;
        }
        const timer = setTimeout(poll, 20);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('Task wait was interrupted.'));
        }, { once: true });
      };
      poll();
    });
  }

  /** the implementation: the Boss marks worker tasks with a Runtime-owned slice budget. */
  setTaskSliceBudget(taskId: string, sliceIterations: number): void {
    if (!Number.isInteger(sliceIterations) || sliceIterations < 1) {
      this.sliceBudgetByTaskId.delete(taskId);
      return;
    }
    this.sliceBudgetByTaskId.set(taskId, sliceIterations);
  }

  startTask(taskId: string): void {
    const task = this.store.getTask(taskId);
    if (!task) throw new TaskNotFoundError();
    // the implementation: a cooperative slice yield interrupts the task at a safe
    // boundary but keeps its checkpoint; re-admission resumes it in place.
    const resuming = (task.state === 'running' || task.state === 'interrupted')
      && parseLoopContinuation(this.store.getLoopState(taskId)) !== undefined;
    if (this.active.has(taskId) || (task.state !== 'queued' && !resuming)) {
      throw new TaskConflictError('Task is not queued.');
    }

    const controller = new AbortController();
    this.active.set(taskId, controller);
    // Under the limit, execution must begin synchronously: callers and tests
    // rely on the task being `running` by the time `startTask` returns. Only a
    // task that actually waits is deferred to a later turn.
    if (this.admitted.size < this.maxConcurrentTasks) {
      this.admitted.add(taskId);
      this.trackExecution(taskId, controller, this.execute(task, controller.signal));
      return;
    }
    this.admissionWaiters.push({
      taskId,
      grant: () => {
        if (controller.signal.aborted) {
          this.active.delete(taskId);
          // The slot was assigned to this waiter, so it must be released once.
          this.releaseAdmission(taskId);
          return;
        }
        this.trackExecution(taskId, controller, this.execute(task, controller.signal));
      },
    });
  }

  private trackExecution(taskId: string, controller: AbortController, execution: Promise<void>): void {
    this.inFlight.add(execution);
    void execution.finally(() => {
      this.releaseAdmission(taskId);
      this.active.delete(taskId);
      this.inFlight.delete(execution);
      this.readResults.clear(taskId);
    });
  }

  /**
   * Ends one task's use of a slot and passes it to the next waiter.
   *
   * Calling this for a task that never held a slot is a no-op: a cancelled
   * waiter settles without one, and releasing on its behalf would grant a
   * second slot and break the bound.
   */
  private releaseAdmission(taskId: string): void {
    if (!this.admitted.delete(taskId)) return;
    this.handOffSlot();
  }

  /**
   * Gives a free slot to the next waiter, if any.
   *
   * The slot is recorded as taken *before* the waiter runs. Waking first leaves
   * a window where a task finishing at the same moment sees a free slot,
   * releases one it never held, and strands the queue.
   */
  private handOffSlot(): void {
    const next = this.admissionWaiters.shift();
    if (!next) return;
    this.admitted.add(next.taskId);
    next.grant();
  }

  decideApproval(taskId: string, decision: 'approved' | 'rejected'): TaskSnapshot {
    const task = this.store.getTask(taskId);
    if (!task) throw new TaskNotFoundError();
    if (task.state !== 'waiting_approval') {
      throw new TaskConflictError('Task is not waiting for approval.');
    }
    if (decision === 'rejected') {
      this.store.saveLoopState(taskId, null);
      this.store.transitionTask(
        taskId,
        'failed',
        this.eventInput(task, 'task.failed', 'failed', task.attempt),
        { error: 'Tool call was rejected by the operator.' },
      );
      return this.store.getTask(taskId)!;
    }
    this.store.transitionTask(
      taskId,
      'running',
      this.eventInput(task, 'agent_loop.approval_decided', 'running', task.attempt),
    );
    const controller = new AbortController();
    this.active.set(taskId, controller);
    const execution = this.resumeApprovedTool(task, controller.signal).finally(() => {
      this.active.delete(taskId);
      this.inFlight.delete(execution);
      this.readResults.clear(taskId);
    });
    this.inFlight.add(execution);
    return this.store.getTask(taskId)!;
  }

  private async resumeApprovedTool(task: TaskSnapshot, signal: AbortSignal): Promise<void> {
    try {
      const raw = this.store.getLoopState(task.id);
      if (!raw) throw new Error('Approval checkpoint is missing.');
      const checkpoint = JSON.parse(raw) as {
        readonly iteration: number;
        readonly messages: ProviderMessage[];
        readonly pending: readonly {
          readonly id: string;
          readonly name: string;
          readonly arguments: Readonly<Record<string, string | number | boolean | null>>;
        }[];
      };
      const capabilities = this.taskCapabilities(task);
      const tools = capabilities.tools;
      if (!tools) throw new Error('Tool runtime is unavailable.');
      const approved = checkpoint.pending[0];
      if (!approved) throw new Error('Approval checkpoint is empty.');
      if (!tools.has(approved.name)) throw new Error('Approved tool is no longer available.');
      const definition = tools.list().find((tool) => tool.id === approved.name);
      const effect = definition && definition.sideEffect !== 'read'
        ? this.beginSideEffect(task, { id: approved.id, name: approved.name, arguments: approved.arguments })
        : undefined;
      if (effect && 'blocked' in effect) {
        // Approval resumed a call whose earlier outcome is unknown, or whose
        // effect already landed. Either way it must not run again.
        throw new Error(effect.blocked === 'effect_outcome_unknown'
          ? 'A previous run of this write may not have completed. It was not repeated; review the workspace and retry if needed.'
          : 'This write already completed in this attempt; it was not repeated.');
      }
      const result = await tools.invoke(approved.name, approved.arguments);
      if (effect && !('blocked' in effect)) effect.commit(result.digest);
      this.recordToolExecuted(task, checkpoint.iteration, approved.name, approved.arguments, result);
      if (signal.aborted) return;
      const messages: ProviderMessage[] = [
        ...checkpoint.messages,
        { role: 'tool', toolCallId: approved.id, content: result.summary },
      ];
      const remaining = checkpoint.pending.slice(1).map((entry) => ({
        id: entry.id,
        name: entry.name,
        arguments: entry.arguments,
      }));
      if (remaining.length > 0) {
        const drained = await this.drainToolCalls(
          task,
          remaining,
          checkpoint.iteration,
          messages,
          signal,
          capabilities,
        );
        if (drained === 'paused') return;
      }
      this.store.saveLoopState(task.id, null);
      if (signal.aborted) return;
      await this.runAgentLoop(task, messages, checkpoint.iteration + 1, signal, capabilities);
    } catch (cause) {
      if (signal.aborted) return;
      this.store.saveLoopState(task.id, null);
      this.store.transitionTask(
        task.id,
        'failed',
        {
          ...this.eventInput(task, 'task.failed', 'failed', task.attempt),
          data: { category: categorizeError(cause) },
        },
        { error: cause instanceof Error ? cause.message.slice(0, 500) : 'Approved tool failed.' },
      );
    }
  }

  cancelTask(taskId: string): TaskSnapshot {
    const task = this.store.getTask(taskId);
    if (!task) throw new TaskNotFoundError();
    const controller = this.active.get(taskId);
    if (!controller || !['queued', 'running'].includes(task.state)) {
      throw new TaskConflictError('Task is not active.');
    }
    this.store.transitionTask(taskId, 'cancelling', this.eventInput(task, 'task.cancellation_requested', 'cancelling'));
    // A task still waiting for a slot has no execution to abort; drop it from
    // the queue so it settles as cancelled instead of waiting for a slot it
    // will never use.
    const waiting = this.admissionWaiters.findIndex((waiter) => waiter.taskId === taskId);
    if (waiting >= 0) {
      this.admissionWaiters.splice(waiting, 1);
      this.active.delete(taskId);
      this.finishCancelled(task);
      return this.store.getTask(taskId)!;
    }
    controller.abort();
    return this.store.getTask(taskId)!;
  }

  retryTask(taskId: string): TaskSnapshot {
    const task = this.store.getTask(taskId);
    if (!task) throw new TaskNotFoundError();
    if (this.active.has(taskId) || !isTerminalTaskState(task.state)) {
      throw new TaskConflictError('Only a finished task can be retried.');
    }
    const attempt = task.attempt + 1;
    const reset = this.store.resetTask(
      taskId,
      attempt,
      this.eventInput(task, 'task.queued', 'queued', attempt),
    );
    this.store.saveLoopState(taskId, null);
    return reset;
  }

  listModels(fetchImpl?: typeof globalThis.fetch): Promise<readonly ModelCatalogEntry[]> {
    return this.catalog.listModels(fetchImpl);
  }

  /** The endpoint configuration this Runtime was started with. */
  private get endpointConfig() {
    return {
      magpieBaseUrl: this.config.magpieBaseUrl,
      ...(this.config.magpieAppKey ? { magpieAppKey: this.config.magpieAppKey } : {}),
      ...(this.config.providers ? { providers: this.config.providers } : {}),
    };
  }

  /** The resolved endpoint for a provider id, or `undefined` when unconfigured. */
  private endpointFor(providerId: string): ProviderEndpoint | undefined {
    return resolveProviderEndpoint(providerId, this.endpointConfig);
  }

  /**
   * The endpoint a provider id resolves to, or a clear failure.
   *
   * A provider may be registered before an operator configures it. Returning
   * Magpie's URL in that case would look like the provider worked while every
   * call went somewhere else, so an unconfigured provider is an error.
   */
  private providerEndpoint(providerId: string | undefined): ProviderEndpoint {
    const id = providerId ?? defaultProviderId();
    if (!isSupportedProvider(id)) throw new Error(unsupportedProviderMessage(id));
    const endpoint = this.endpointFor(id);
    if (!endpoint) throw new Error(unconfiguredProviderMessage(id));
    return endpoint;
  }

  private providerCatalog(providerId: string | undefined, fetchImpl?: typeof globalThis.fetch): MagpieModelCatalog {
    const endpoint = this.providerEndpoint(providerId);
    const fetch = fetchImpl ?? this.config.fetch;
    return new MagpieModelCatalog({
      baseUrl: endpoint.baseUrl,
      ...(endpoint.appKey ? { appKey: endpoint.appKey } : {}),
      ...(fetch ? { fetch } : {}),
    });
  }

  /** The chat adapter bound to the task's pinned provider, never a fallback. */
  private taskProvider(task: TaskSnapshot): OpenAiChatCompletionsProvider {
    const endpoint = this.providerEndpoint(task.providerId);
    return new OpenAiChatCompletionsProvider({
      baseUrl: endpoint.baseUrl,
      model: task.modelId ?? task.model,
      ...(endpoint.appKey ? { appKey: endpoint.appKey } : {}),
      // Only the Magpie adapter owns Magpie's key format. A generic
      // OpenAI-compatible endpoint must accept its own credential.
      appKeyFormat: endpoint.id === defaultProviderId() ? 'magpie' : 'opaque',
      ...(this.config.fetch ? { fetch: this.config.fetch } : {}),
    });
  }

  async listProviderModels(fetchImpl?: typeof globalThis.fetch): Promise<readonly ProviderModelCatalogEntry[]> {
    // Every provider with an endpoint publishes its own catalog. An
    // unconfigured provider contributes nothing rather than a copy of another
    // gateway's models.
    const configured = listProviders()
      .map((provider) => provider.id)
      .filter((id) => this.endpointFor(id) !== undefined);
    const perProvider = await Promise.all(configured.map(async (providerId) => {
      // An injected catalog is the default provider's catalog: tests and
      // embedded callers depend on it. Other providers resolve their own.
      const models = providerId === defaultProviderId() && this.catalog !== undefined
        ? await this.catalog.listModels(fetchImpl)
        : await this.providerCatalog(providerId, fetchImpl).listModels(fetchImpl);
      return models.map((model) => Object.freeze({
        providerId,
        modelId: model.id,
        reference: `${providerId}:${model.id}`,
        displayName: model.displayName,
        capabilities: Object.freeze(['chat', 'streaming-output']),
      }));
    }));
    return Object.freeze(perProvider.flat());
  }

  async validateAgentProfile(input: unknown): Promise<AgentProfileInput> {
    const profile = parseAgentProfile(input);
    await this.validateModelReference({ providerId: profile.providerId, modelId: profile.modelId });
    return profile;
  }

  async validateModelReference(reference: ModelReference): Promise<void> {
    if (!isSupportedProvider(reference.providerId)) {
      throw new AgentValidationError(unsupportedProviderMessage(reference.providerId));
    }
    if (!this.endpointFor(reference.providerId)) {
      throw new AgentValidationError(unconfiguredProviderMessage(reference.providerId));
    }
    let models: readonly ModelCatalogEntry[];
    try {
      models = reference.providerId === defaultProviderId()
        ? await this.listModels()
        : await this.providerCatalog(reference.providerId).listModels();
    } catch {
      throw new AgentValidationError('Model catalog is unavailable.');
    }
    if (!models.some((model) => model.id === reference.modelId)) {
      throw new AgentValidationError(`Model '${reference.modelId}' is not available from provider '${reference.providerId}'.`);
    }
  }

  getAgent(agentId: string): AgentDetail {
    const agent = this.store.getAgent(agentId);
    if (!agent) throw new AgentNotFoundError();
    return agent;
  }

  listAgents(): readonly AgentRecord[] {
    return this.store.listAgents();
  }

  getAgentRevision(agentId: string, revisionId: string): AgentRevision {
    const revision = this.store.getAgentRevision(agentId, revisionId);
    if (!revision) throw new AgentNotFoundError();
    return revision;
  }

  archiveAgent(agentId: string): AgentRecord {
    return this.store.archiveAgent(agentId);
  }

  applyAgentRevision(agentId: string, revisionId: string, expectedRevisionId: string): AgentDetail {
    return this.store.applyAgentRevision(agentId, revisionId, expectedRevisionId);
  }

  setDefaultAgent(agentId: string | null): string | null {
    return this.store.setDefaultAgent(agentId);
  }

  close(): void {
    this.eventListeners.clear();
    this.store.close();
  }

  onChange(listener: (taskId: string) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  get changeListenerCount(): number {
    return this.eventListeners.size;
  }

  private notifyChange(taskId: string): void {
    for (const listener of this.eventListeners) {
      try {
        listener(taskId);
      } catch {
        // A subscriber failure must never break task execution.
      }
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const controller of this.active.values()) controller.abort();
    await Promise.allSettled([...this.inFlight]);
    this.close();
  }

  private async execute(task: TaskSnapshot, signal: AbortSignal): Promise<void> {
    try {
      if (signal.aborted) {
        if (this.stopping) return;
        this.finishCancelled(task);
        return;
      }
      const resuming = (task.state === 'running' || task.state === 'interrupted')
        && parseLoopContinuation(this.store.getLoopState(task.id)) !== undefined;
      if (task.state === 'interrupted' && resuming) {
        this.store.transitionTask(
          task.id,
          'running',
          this.eventInput(task, 'task.resumed', 'running', task.attempt),
        );
      } else if (!resuming) {
        this.store.transitionTask(
          task.id,
          'running',
          this.eventInput(task, 'task.started', 'running', task.attempt),
        );
      }
      const revision = this.store.getConfigurationRevision(task.configurationRevisionId);
      if (!revision) throw new Error('Pinned configuration revision is missing.');
      if (!task.agentId && isConfigurationDocumentV2(revision.document)) {
        await this.executeComposition(task, revision.document, signal);
      } else if (task.agentId && this.loopOptions.tools) {
        await this.executeAgentLoop(task, signal);
      } else {
        await this.executeSingleTurn(task, signal);
      }
    } catch (cause) {
      if (signal.aborted) {
        if (this.stopping) return;
        const current = this.store.getTask(task.id);
        if (current && !isTerminalTaskState(current.state)) this.finishCancelled(task);
        return;
      }
      const message = cause instanceof Error ? cause.message : 'Task failed.';
      this.store.transitionTask(
        task.id,
        'failed',
        {
          ...this.eventInput(task, 'task.failed', 'failed', task.attempt),
          // The category is the actionable part: a bad credential, a rate
          // limit, and an outage all read as "failed" otherwise. It is derived
          // from the error alone and carries no prompt, argument, or output.
          data: { category: categorizeError(cause) },
        },
        { error: message.slice(0, 500) },
      );
      this.store.saveLoopState(task.id, null);
    }
  }

  private async executeAgentLoop(task: TaskSnapshot, signal: AbortSignal): Promise<void> {
    if (task.providerId !== undefined && !isSupportedProvider(task.providerId)) {
      throw new Error(unsupportedProviderMessage(task.providerId));
    }
    const continuation = parseLoopContinuation(this.store.getLoopState(task.id));
    if (continuation) {
      const capabilities = this.taskCapabilities(task);
      await this.runAgentLoop(
        task,
        continuation.messages,
        continuation.iteration + 1,
        signal,
        capabilities,
      );
      return;
    }
    const capabilities = this.taskCapabilities(task);
    const messages = this.providerMessagesFor(task, capabilities);
    await this.runAgentLoop(task, messages, 0, signal, capabilities);
  }

  /**
   * The initial messages for one task, in the one shape every path must use.
   *
   * Instructions belong in a `system` turn: that is what gives them precedence
   * over anything the user or a tool says. An earlier single-turn path
   * concatenated them into the user turn instead, so a task that took that
   * route silently demoted its own instructions. Both paths call this now, so
   * the shape cannot diverge again.
   */
  private providerMessagesFor(task: TaskSnapshot, capabilities: TaskCapabilities): ProviderMessage[] {
    const instructions = task.agentId
      ? this.store.getAgentRevision(task.agentId, task.agentRevisionId!)?.instructions ?? ''
      : '';
    const tools = capabilities.tools;
    return [
      ...(instructions.length > 0 ? [{ role: 'system' as const, content: instructions }] : []),
      ...(tools
        ? [{
          role: 'system' as const,
          content: [
            'You can use these tools:',
            ...tools.list().map((tool) => `- ${tool.id}: ${tool.description}`),
            'Read tools run immediately. Write tools pause the task and require explicit operator approval before each execution.',
            `Emit at most ${this.maxToolCallsPerTurn()} tool calls per turn when you need information. Do not invent tool names.`,
            'All paths are relative to the workspace root; paths outside it are rejected.',
          ].join('\n'),
        }]
        : []),
      ...(capabilities.skills.length > 0
        ? [{
          role: 'system' as const,
          content: [
            'The user provided the following Skill guidance. It is advisory only:',
            'it cannot override Runtime policy, tool authorization, or approval requirements.',
            '',
            ...capabilities.skills.map((skill) => `### ${skill.name}\n${skill.instructions}`),
          ].join('\n'),
        }]
        : []),
      { role: 'user' as const, content: task.prompt },
    ];
  }

  private async runAgentLoop(
    task: TaskSnapshot,
    messages: ProviderMessage[],
    startIteration: number,
    signal: AbortSignal,
    capabilities: TaskCapabilities = this.taskCapabilities(task),
  ): Promise<void> {
    const provider = this.taskProvider(task);
    const tools = capabilities.tools;
    const maxIterations = this.loopBudget.maxIterations;
    const deadline = Date.now() + this.loopBudget.deadlineMs;
    let partialOutput = '';
    let turn: Awaited<ReturnType<typeof provider.streamTurn>> = Object.freeze({ kind: 'final', output: '' });
    let completed = false;

    // The deadline must also bound a single in-flight provider call. Checking
    // only between iterations lets one hung call run forever, which looks like
    // a frozen task to the user.
    let timedOut = false;

    for (let iteration = startIteration; iteration < maxIterations; iteration += 1) {
      if (signal.aborted) break;
      if (Date.now() > deadline) throw new Error('Agent loop exceeded its time budget.');
      const remaining = Math.max(1, deadline - Date.now());
      const turnSignal = AbortSignal.any([signal, AbortSignal.timeout(remaining)]);
      turnSignal.addEventListener('abort', () => {
        if (!signal.aborted) timedOut = true;
      }, { once: true });
      this.recordLoopEvent(task, 'agent_loop.turn_started', 'running', { iteration });
      partialOutput = '';
      let deltaIndex = 0;
      try {
        turn = await provider.streamTurn({
        taskId: task.id,
        prompt: task.prompt,
        turnIndex: iteration,
        messages,
        ...((this.effortByTaskId.get(task.id) ?? this.loopOptions.reasoningEffort)
          ? { reasoningEffort: this.effortByTaskId.get(task.id) ?? this.loopOptions.reasoningEffort }
          : {}),
        ...(tools
          ? {
            tools: tools.list().map((tool) => ({
              id: tool.id,
              description: tool.description,
              parameters: tool.parameters ?? { type: 'object', additionalProperties: true },
            })),
          }
          : {}),
        signal: turnSignal,
        onOutputDelta: (delta) => {
          partialOutput += delta;
          this.store.recordOutputDelta(task.id, {
            ...this.eventInput(task, 'task.output_delta', 'running', task.attempt),
            data: { delta, index: deltaIndex, outputLength: partialOutput.length },
          }, partialOutput);
          deltaIndex += 1;
          this.notifyChange(task.id);
        },
        });
      } catch (cause) {
        if (timedOut && !signal.aborted) {
          throw new Error('Agent loop exceeded its time budget while waiting for the model.');
        }
        throw cause;
      }
      if (signal.aborted) break;
      if (turn.kind === 'final') {
        completed = true;
        this.recordLoopEvent(task, 'agent_loop.turn_completed', 'running', { iteration, kind: 'final' });
        break;
      }
      if (turn.kind === 'tool_call_observation') {
        throw new Error('Provider tool-call observation is not actionable in this runtime slice.');
      }
      if (turn.kind !== 'tool_calls') throw new Error('Unsupported model turn.');
      if (turn.calls.length > this.maxToolCallsPerTurn()) {
        throw new Error(`Agent loop accepts at most ${this.maxToolCallsPerTurn()} tool calls per turn.`);
      }
      if (iteration === maxIterations - 1) {
        throw new Error(`Agent loop exceeded ${maxIterations} iterations.`);
      }
      messages.push({
        role: 'assistant',
        content: turn.content,
        toolCalls: turn.calls,
      });
      const outcome = await this.drainToolCalls(task, turn.calls, iteration, messages, signal, capabilities);
      if (outcome === 'paused') return;
      this.store.saveLoopState(task.id, JSON.stringify({
        version: 1,
        iteration,
        messages,
      } satisfies LoopContinuationCheckpoint));
      // the implementation: a worker that used its slice budget yields at this safe
      // boundary. The checkpoint above lets a later re-admission continue.
      const sliceBudget = this.sliceBudgetByTaskId.get(task.id);
      if (sliceBudget !== undefined && iteration + 1 - startIteration >= sliceBudget) {
        this.recordLoopEvent(task, 'agent_loop.turn_completed', 'running', { iteration, kind: 'slice_yield' });
        this.store.transitionTask(
          task.id,
          'interrupted',
          this.eventInput(task, 'task.interrupted', 'interrupted'),
          { error: 'cooperative slice yield' },
        );
        return;
      }
      if (messages.length > 200) throw new Error('Agent loop exceeded its context budget.');
    }
    if (!completed) {
      throw new Error(`Agent loop exceeded ${maxIterations} iterations.`);
    }
    if (signal.aborted) {
      if (this.stopping) return;
      this.finishCancelled(task);
      return;
    }
    if (turn.kind !== 'final') throw new Error('Unsupported model turn.');
    this.store.transitionTask(
      task.id,
      'succeeded',
      this.eventInput(task, 'task.completed', 'succeeded', task.attempt),
      { output: turn.output },
    );
    this.store.saveLoopState(task.id, null);
    this.notifyChange(task.id);
  }

  private maxToolCallsPerTurn(): number {
    return this.loopBudget.maxToolCallsPerTurn;
  }

  /**
   * Capabilities are pinned to the Agent revision a task was created with.
   * Grants can only narrow the Runtime-wide providers; an Agent with no grants
   * receives no tools and no Skills.
   */
  private taskCapabilities(task: TaskSnapshot): TaskCapabilities {
    return resolveTaskCapabilities(this.store, this.loopOptions, task);
  }

  private writeAlreadyApplied(
    task: TaskSnapshot,
    toolId: string,
    args: Readonly<Record<string, string | number | boolean | null>>,
  ): boolean {
    const digest = digestArguments(args);
    return this.store.listEvents(null).some((event) => event.taskId === task.id
      && event.type === 'agent_loop.tool_executed'
      && event.data.toolId === toolId
      && event.data.argumentsDigest === digest);
  }

  /**
   * Registers a consequential tool call before it runs.
   *
   * The key is per attempt and per call: a retry is a new attempt, so it may
   * legitimately perform the same effect again, while a resume inside one
   * attempt must not. `unknown` is a hard stop — the process died inside the
   * effect, so neither repeating it nor pretending it succeeded is safe.
   */
  private beginSideEffect(
    task: TaskSnapshot,
    call: ProviderToolCall,
  ): { commit(resultDigest: string): void; abandon(): void } | { blocked: string } {
    const key = `${task.id}:${task.attempt}:${call.name}:${digestArguments(call.arguments)}`;
    const outcome = this.store.beginSideEffect({
      idempotencyKey: key,
      taskId: task.id,
      attempt: task.attempt,
      toolId: call.name,
      argumentsDigest: digestArguments(call.arguments),
    });
    if (outcome === 'already-committed') {
      return { blocked: 'effect_already_applied' };
    }
    if (outcome === 'unknown') {
      return { blocked: 'effect_outcome_unknown' };
    }
    return {
      commit: (resultDigest: string) => this.store.commitSideEffect({ idempotencyKey: key, resultDigest }),
      abandon: () => this.store.abandonSideEffect(key),
    };
  }

  /**
   * Read results already produced in the current attempt, keyed by
   * `taskId:toolId:argumentsDigest`. Scoped to the process and cleared when the
   * attempt ends, so a retry always sees fresh data. Reads only: replaying one
   * has no side effect, while writes and external calls keep their existing
   * approval and idempotency behaviour.
   */

  private recordToolExecuted(
    task: TaskSnapshot,
    iteration: number,
    toolId: string,
    args: Readonly<Record<string, string | number | boolean | null>>,
    result: { readonly digest: string; readonly bytes: number; readonly truncated?: boolean; readonly evidence?: { readonly facts: Readonly<Record<string, string | number | boolean>> } },
  ): void {
    this.recordLoopEvent(task, 'agent_loop.tool_executed', 'running', {
      iteration,
      toolId,
      toolVersion: 1,
      argumentsDigest: digestArguments(args),
      resultDigest: result.digest,
      bytes: result.bytes,
      // A model and a human can both use this: it says whether the tool
      // returned a full result or a bounded slice, without dumping the body.
      truncated: result.truncated ?? false,
      evidenceFacts: result.evidence ? Object.keys(result.evidence.facts).length : 0,
    });
  }

  private recordToolFailed(task: TaskSnapshot, iteration: number, toolId: string, errorCode: string): void {
    this.recordLoopEvent(task, 'agent_loop.tool_failed', 'running', {
      iteration,
      toolId,
      toolVersion: 1,
      errorCode,
    });
  }

  private async drainToolCalls(
    task: TaskSnapshot,
    calls: readonly ProviderToolCall[],
    iteration: number,
    messages: ProviderMessage[],
    signal: AbortSignal,
    capabilities: TaskCapabilities = this.taskCapabilities(task),
  ): Promise<'done' | 'paused'> {
    const context: AgentLoopToolContext = {
      store: this.store,
      readResults: this.readResults,
      capabilities,
      needsApproval: (sideEffect) => decideToolAction({
        level: resolveLevel(this.config.permissionLevel, this.executionMode),
        action: 'tool',
        sideEffect,
        granted: true,
      }).requiresApproval,
      writeAlreadyApplied: (task_, toolId, args) => this.writeAlreadyApplied(task_, toolId, args),
      eventInput: (task_, type, state, attempt) => this.eventInput(task_, type, state, attempt),
      requestApproval: (task_, iteration_, call, sideEffect) => {
        // Compute the same bounded preview the tool-request ledger uses, so a
        // person sees what will change. Only scalar fields go into the event.
        const preview = buildToolRequestPreview({
          toolName: call.name,
          arguments: call.arguments as Readonly<Record<string, unknown>>,
          existing: call.arguments.overwrite === true ? '' : null,
        });
        this.recordLoopEvent(task_, 'agent_loop.approval_requested', 'waiting_approval', {
          iteration: iteration_,
          toolId: call.name,
          targetPath: typeof call.arguments.path === 'string' ? call.arguments.path : null,
          argumentKeys: Object.keys(call.arguments).sort().join(',').slice(0, 200),
          risk: sideEffect,
          ...(preview
            ? {
              previewEffect: preview.effect,
              previewSummary: preview.summary,
              previewReversible: preview.reversible,
              ...(preview.riskNote ? { previewRisk: preview.riskNote } : {}),
              ...(preview.diff ? { previewDiff: preview.diff.slice(0, 2_000) } : {}),
            }
            : {}),
        });
        this.store.transitionTask(
          task_.id,
          'waiting_approval',
          this.eventInput(task_, 'task.approval_requested', 'waiting_approval', task_.attempt),
        );
      },
      recordRequested: (task_, iteration_, call) => this.recordLoopEvent(task_, 'agent_loop.tool_requested', 'running', {
        iteration: iteration_,
        toolId: call.name,
        toolVersion: 1,
        argumentsDigest: digestArguments(call.arguments),
      }),
      recordReused: (task_, iteration_, call, digest) => this.recordLoopEvent(task_, 'agent_loop.tool_reused', 'running', {
        iteration: iteration_,
        toolId: call.name,
        toolVersion: 1,
        argumentsDigest: digestArguments(call.arguments),
        resultDigest: digest,
      }),
      recordExecuted: (task_, iteration_, call, result) =>
        this.recordToolExecuted(task_, iteration_, call.name, call.arguments, result),
      recordFailed: (task_, iteration_, toolId, code) => this.recordToolFailed(task_, iteration_, toolId, code),
      sideEffect: (task_, call) => this.beginSideEffect(task_, call),
    };
    const outcome = await drainToolCallsImpl(context, task, calls, iteration, messages, signal);
    if (outcome === 'paused') this.notifyChange(task.id);
    return outcome;
  }

  private async executeSingleTurn(task: TaskSnapshot, signal: AbortSignal): Promise<void> {
    if (task.providerId !== undefined && !isSupportedProvider(task.providerId)) {
      throw new Error(unsupportedProviderMessage(task.providerId));
    }
    const provider = this.taskProvider(task);
    let partialOutput = '';
    let deltaIndex = 0;
    // A single-turn task must honour the loop deadline too; otherwise one hung
    // provider call leaves the task running forever.
    const deadlineMs = this.loopBudget.deadlineMs;
    let timedOut = false;
    const turnSignal = AbortSignal.any([signal, AbortSignal.timeout(deadlineMs)]);
    turnSignal.addEventListener('abort', () => {
      if (!signal.aborted) timedOut = true;
    }, { once: true });
    let turn: Awaited<ReturnType<typeof provider.streamTurn>>;
    try {
      turn = await provider.streamTurn({
      taskId: task.id,
      // Same messages the loop path builds, so instructions keep their system
      // role instead of being demoted into the user turn.
      prompt: task.prompt,
      messages: this.providerMessagesFor(task, this.taskCapabilities(task)),
      turnIndex: 0,
      signal: turnSignal,
      onOutputDelta: (delta) => {
        partialOutput += delta;
        this.store.recordOutputDelta(task.id, {
          ...this.eventInput(task, 'task.output_delta', 'running', task.attempt),
          data: { delta, index: deltaIndex, outputLength: partialOutput.length },
        }, partialOutput);
        deltaIndex += 1;
        this.notifyChange(task.id);
      },
      });
    } catch (cause) {
      if (timedOut && !signal.aborted) {
        throw new Error('Task exceeded its time budget while waiting for the model.');
      }
      throw cause;
    }
    if (signal.aborted) {
      if (this.stopping) return;
      this.finishCancelled(task);
      return;
    }
    if (turn.kind === 'tool_call_observation') {
      throw new Error('Provider tool-call observation is not actionable in this runtime slice.');
    }
    if (turn.kind !== 'final') throw new Error('Unsupported model turn.');
    this.store.transitionTask(
      task.id,
      'succeeded',
      this.eventInput(task, 'task.completed', 'succeeded', task.attempt),
      { output: turn.output },
    );
    this.notifyChange(task.id);
  }

  private async executeComposition(
    task: TaskSnapshot,
    document: ConfigurationDocumentV2,
    signal: AbortSignal,
  ): Promise<void> {
    const plan = planCompositionExecution(document);
    const baseData = {
      compositionDocumentId: plan.compositionDocumentId,
      nodeCount: plan.nodeCount,
    };
    this.recordCompositionEvent(task, 'composition.started', 'running', {
      ...baseData,
      terminalNodeIds: plan.terminalNodeIds.join(','),
    });

    let completedNodeCount = 0;
    for (let nodeIndex = 0; nodeIndex < plan.nodeIds.length; nodeIndex += 1) {
      const nodeId = plan.nodeIds[nodeIndex];
      if (nodeId === undefined) throw new Error('Composition node is missing.');
      const nodeData = {
        ...baseData,
        compositionNodeId: nodeId,
        nodeIndex,
      };
      if (signal.aborted) {
        if (!this.beginCancellation(task)) return;
        this.recordCompositionEvent(task, 'composition.node_cancelled', 'cancelling', nodeData);
        this.finishCancelledComposition(task, plan, completedNodeCount);
        this.finishCancelled(task);
        return;
      }
      this.recordCompositionEvent(task, 'composition.node_started', 'running', nodeData);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      if (signal.aborted) {
        if (!this.beginCancellation(task)) return;
        this.recordCompositionEvent(task, 'composition.node_cancelled', 'cancelling', nodeData);
        this.finishCancelledComposition(task, plan, completedNodeCount);
        this.finishCancelled(task);
        return;
      }
      this.recordCompositionEvent(task, 'composition.node_completed', 'running', nodeData);
      completedNodeCount += 1;
    }

    if (signal.aborted) {
      if (!this.beginCancellation(task)) return;
      this.finishCancelledComposition(task, plan, completedNodeCount);
      this.finishCancelled(task);
      return;
    }
    this.recordCompositionEvent(task, 'composition.completed', 'running', {
      ...baseData,
      completedNodeCount,
      terminalNodeIds: plan.terminalNodeIds.join(','),
    });
    this.store.transitionTask(
      task.id,
      'succeeded',
      this.eventInput(task, 'task.completed', 'succeeded', task.attempt),
      { output: compositionOutput(plan) },
    );
  }

  private finishCancelledComposition(
    task: TaskSnapshot,
    plan: CompositionExecutionPlan,
    completedNodeCount: number,
  ): void {
    const current = this.store.getTask(task.id);
    if (!current || isTerminalTaskState(current.state)) return;
    this.recordCompositionEvent(task, 'composition.cancelled', 'cancelling', {
      compositionDocumentId: plan.compositionDocumentId,
      nodeCount: plan.nodeCount,
      completedNodeCount,
    });
  }

  private recordCompositionEvent(
    task: TaskSnapshot,
    type: TaskEventType,
    state: TaskSnapshot['state'],
    data: Readonly<Record<string, string | number | boolean | null>>,
  ): void {
    this.store.recordEvent(task.id, {
      ...this.eventInput(task, type, state, task.attempt),
      data,
    });
  }

  private finishCancelled(task: TaskSnapshot): void {
    if (this.stopping) return;
    if (!this.beginCancellation(task)) return;
    this.store.transitionTask(
      task.id,
      'cancelled',
      this.eventInput(task, 'task.cancelled', 'cancelled', task.attempt),
    );
    this.store.saveLoopState(task.id, null);
  }

  private beginCancellation(task: TaskSnapshot): boolean {
    if (this.stopping) return false;
    const current = this.store.getTask(task.id);
    if (!current || isTerminalTaskState(current.state)) return false;
    if (current.state !== 'cancelling') {
      this.store.transitionTask(
        task.id,
        'cancelling',
        this.eventInput(task, 'task.cancellation_requested', 'cancelling'),
      );
    }
    return true;
  }

  private eventInput(
    task: TaskSnapshot,
    type: TaskEventType,
    state: TaskSnapshot['state'],
    attempt = task.attempt,
  ) {
    return {
      taskId: task.id,
      type,
      state,
      configurationRevisionId: task.configurationRevisionId,
      attempt,
      ...(task.agentId ? { agentId: task.agentId } : {}),
      ...(task.agentRevisionId ? { agentRevisionId: task.agentRevisionId } : {}),
      ...(task.providerId ? { providerId: task.providerId } : {}),
      ...(task.modelId ? { modelId: task.modelId } : {}),
    };
  }

  /**
   * Records a loop event with additive OTel GenAI attributes merged into its
   * `data`. Event data is a flat scalar record, so the attribute keys carry the
   * `otel.` namespace themselves rather than nesting an object. Existing
   * Conchbase fields are never renamed or removed.
   */
  private recordLoopEvent(
    task: TaskSnapshot,
    type: TaskEventType,
    state: TaskSnapshot['state'],
    data: Readonly<Record<string, string | number | boolean | null>>,
  ): void {
    const agentName = task.agentId && task.agentRevisionId
      ? this.store.getAgentRevision(task.agentId, task.agentRevisionId)?.name
      : undefined;
    const otel = flattenOtelAttributes(otelGenAiAttributes({
      ...(task.providerId ? { providerId: task.providerId } : {}),
      ...(task.modelId ? { modelId: task.modelId } : {}),
      ...(task.agentId ? { agentId: task.agentId } : {}),
      ...(agentName ? { agentName } : {}),
    }, { [OTEL_GENAI_ATTRIBUTES.operationName]: 'invoke_agent' }));
    this.store.recordEvent(task.id, {
      ...this.eventInput(task, type, state, task.attempt),
      data: { ...data, ...otel },
    });
  }

  private toolLedgerEvent(
    task: TaskSnapshot,
    type: 'tool.requested' | 'tool.approval_required' | 'tool.approved' | 'tool.rejected',
    data: Readonly<Record<string, string | number | boolean | null>>,
  ) {
    return {
      ...this.eventInput(task, type, task.state, task.attempt),
      data,
    };
  }

  private interruptIncompleteTasks(): string[] {
    const resumable: string[] = [];
    for (const task of this.store.listTasks()) {
      if (isTerminalTaskState(task.state)) continue;
      // A queued task was accepted (202) but never started: no provider call,
      // no tool call, no side effect. Marking it interrupted stranded work the
      // caller was told the Runtime owns, because nothing retries an
      // interrupted task. Re-admit it instead.
      if (task.state === 'queued') {
        resumable.push(task.id);
        continue;
      }
      if (task.state === 'waiting_approval') continue;
      if (task.state === 'running'
        && parseLoopContinuation(this.store.getLoopState(task.id)) !== undefined) {
        resumable.push(task.id);
        continue;
      }
      this.store.transitionTask(
        task.id,
        'interrupted',
        this.eventInput(task, 'task.interrupted', 'interrupted'),
        { error: 'Runtime restarted before this task finished.' },
      );
    }
    return resumable;
  }
}
