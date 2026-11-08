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

export interface TaskServiceConfig {
  readonly magpieBaseUrl: string;
  readonly magpieAppKey?: string;
  readonly defaultModel: string;
  readonly fetch?: typeof globalThis.fetch;
}

export interface CreateTaskInput {
  readonly prompt: string;
  readonly model?: string;
}

export class TaskValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskValidationError';
  }
}

export { ConfigurationValidationError, StoreRevisionNotFoundError as ConfigurationRevisionNotFoundError };

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
): TaskService {
  const store = new SqliteTaskStore(filename);
  const catalog = new MagpieModelCatalog({
    baseUrl: config.magpieBaseUrl,
    ...(config.magpieAppKey ? { appKey: config.magpieAppKey } : {}),
    ...(config.fetch ? { fetch: config.fetch } : {}),
  });
  return new TaskService(store, config, catalog);
}

export class TaskService {
  readonly store: TaskStore;
  private readonly active = new Map<string, AbortController>();
  private readonly config: TaskServiceConfig;
  private readonly catalog: ModelCatalogClient;

  constructor(
    store: TaskStore,
    config: TaskServiceConfig,
    catalog?: ModelCatalogClient,
  ) {
    this.store = store;
    this.config = config;
    this.catalog = catalog ?? new MagpieModelCatalog({
      baseUrl: config.magpieBaseUrl,
      ...(config.magpieAppKey ? { appKey: config.magpieAppKey } : {}),
      ...(config.fetch ? { fetch: config.fetch } : {}),
    });
    this.interruptIncompleteTasks();
  }

  get activeConfigurationRevisionId(): string {
    return this.getConfigurationState().active.id;
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

  startTask(taskId: string): void {
    const task = this.store.getTask(taskId);
    if (!task) throw new TaskNotFoundError();
    if (this.active.has(taskId) || task.state !== 'queued') {
      throw new TaskConflictError('Task is not queued.');
    }

    const controller = new AbortController();
    this.active.set(taskId, controller);
    void this.execute(task, controller.signal).finally(() => {
      this.active.delete(taskId);
    });
  }

  cancelTask(taskId: string): TaskSnapshot {
    const task = this.store.getTask(taskId);
    if (!task) throw new TaskNotFoundError();
    const controller = this.active.get(taskId);
    if (!controller || !['queued', 'running'].includes(task.state)) {
      throw new TaskConflictError('Task is not active.');
    }
    this.store.transitionTask(taskId, 'cancelling', this.eventInput(task, 'task.cancellation_requested', 'cancelling'));
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
    return this.store.resetTask(
      taskId,
      attempt,
      this.eventInput(task, 'task.queued', 'queued', attempt),
    );
  }

  listModels(fetchImpl?: typeof globalThis.fetch): Promise<readonly ModelCatalogEntry[]> {
    return this.catalog.listModels(fetchImpl);
  }

  close(): void {
    for (const controller of this.active.values()) controller.abort();
    this.store.close();
  }

  private async execute(task: TaskSnapshot, signal: AbortSignal): Promise<void> {
    try {
      if (signal.aborted) {
        this.finishCancelled(task);
        return;
      }
      this.store.transitionTask(
        task.id,
        'running',
        this.eventInput(task, 'task.started', 'running', task.attempt),
      );
      const revision = this.store.getConfigurationRevision(task.configurationRevisionId);
      if (!revision) throw new Error('Pinned configuration revision is missing.');
      if (isConfigurationDocumentV2(revision.document)) {
        await this.executeComposition(task, revision.document, signal);
      } else {
        await this.executeSingleTurn(task, signal);
      }
    } catch (cause) {
      if (signal.aborted) {
        const current = this.store.getTask(task.id);
        if (current && !isTerminalTaskState(current.state)) this.finishCancelled(task);
        return;
      }
      const message = cause instanceof Error ? cause.message : 'Task failed.';
      this.store.transitionTask(
        task.id,
        'failed',
        this.eventInput(task, 'task.failed', 'failed', task.attempt),
        { error: message.slice(0, 500) },
      );
    }
  }

  private async executeSingleTurn(task: TaskSnapshot, signal: AbortSignal): Promise<void> {
    const provider = new OpenAiChatCompletionsProvider({
      baseUrl: this.config.magpieBaseUrl,
      model: task.model,
      ...(this.config.magpieAppKey ? { appKey: this.config.magpieAppKey } : {}),
      ...(this.config.fetch ? { fetch: this.config.fetch } : {}),
    });

    let partialOutput = '';
    let deltaIndex = 0;
    const turn = await provider.streamTurn({
      taskId: task.id,
      prompt: task.prompt,
      turnIndex: 0,
      signal,
      onOutputDelta: (delta) => {
        partialOutput += delta;
        const event = this.eventInput(
          task,
          'task.output_delta',
          'running',
          task.attempt,
        );
        this.store.recordOutputDelta(task.id, {
          ...event,
          data: {
            delta,
            index: deltaIndex,
            outputLength: partialOutput.length,
          },
        }, partialOutput);
        deltaIndex += 1;
      },
    });
    if (signal.aborted) {
      this.finishCancelled(task);
      return;
    }
    if (turn.kind !== 'final') {
      throw new Error('Unsupported model turn.');
    }
    this.store.transitionTask(
      task.id,
      'succeeded',
      this.eventInput(task, 'task.completed', 'succeeded', task.attempt),
      { output: turn.output },
    );
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
    if (!this.beginCancellation(task)) return;
    this.store.transitionTask(
      task.id,
      'cancelled',
      this.eventInput(task, 'task.cancelled', 'cancelled', task.attempt),
    );
  }

  private beginCancellation(task: TaskSnapshot): boolean {
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
    };
  }

  private interruptIncompleteTasks(): void {
    for (const task of this.store.listTasks()) {
      if (isTerminalTaskState(task.state)) continue;
      this.store.transitionTask(
        task.id,
        'interrupted',
        this.eventInput(task, 'task.interrupted', 'interrupted'),
        { error: 'Runtime restarted before this task finished.' },
      );
    }
  }
}
