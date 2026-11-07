import { randomUUID } from 'node:crypto';
import { createConfigurationRevisionStore } from './configuration-revision.js';
import {
  MagpieModelCatalog,
  type ModelCatalogClient,
  type ModelCatalogEntry,
} from './model-catalog.js';
import { OpenAiChatCompletionsProvider } from './magpie-provider.js';
import { isTerminalTaskState, type TaskEventType } from './task-lifecycle.js';
import {
  SqliteTaskStore,
  TaskConflictError,
  TaskNotFoundError,
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

const revision = createConfigurationRevisionStore({
  profile: ['phase-1-single-turn'],
  skills: [],
  policies: ['no-model-tool-execution'],
  mcpServers: [],
}).active;

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
    return revision.id;
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
      configurationRevisionId: revision.id,
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
    const provider = new OpenAiChatCompletionsProvider({
      baseUrl: this.config.magpieBaseUrl,
      model: task.model,
      ...(this.config.magpieAppKey ? { appKey: this.config.magpieAppKey } : {}),
      ...(this.config.fetch ? { fetch: this.config.fetch } : {}),
    });

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
    } catch (cause) {
      if (signal.aborted) {
        this.finishCancelled(task);
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

  private finishCancelled(task: TaskSnapshot): void {
    const current = this.store.getTask(task.id);
    if (!current || isTerminalTaskState(current.state)) return;
    this.store.transitionTask(
      task.id,
      'cancelled',
      this.eventInput(task, 'task.cancelled', 'cancelled', task.attempt),
    );
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
