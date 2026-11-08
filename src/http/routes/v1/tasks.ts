import type { FastifyInstance } from 'fastify';
import {
  TaskValidationError,
  ToolRequestConflictError,
  ToolRequestNotFoundError,
} from '../../../runtime/task-service.js';
import {
  TaskConflictError,
  TaskNotFoundError,
} from '../../../runtime/task-store.js';
import type { TaskService } from '../../../runtime/task-service.js';

const createTaskSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt'],
  properties: {
    prompt: { type: 'string', minLength: 1, maxLength: 20_000 },
    model: { type: 'string', minLength: 1, maxLength: 300 },
  },
} as const;

function unavailable(reply: {
  code(status: number): { send(payload: unknown): unknown };
}) {
  return reply.code(503).send({ error: 'Task service is not configured.' });
}

function toTaskResponse(task: {
  readonly id: string;
  readonly prompt: string;
  readonly model: string;
  readonly configurationRevisionId: string;
  readonly state: string;
  readonly attempt: number;
  readonly output: string | null;
  readonly partialOutput: string | null;
  readonly error: string | null;
}) {
  return {
    id: task.id,
    prompt: task.prompt,
    model: task.model,
    configurationRevisionId: task.configurationRevisionId,
    state: task.state,
    attempt: task.attempt,
    output: task.output,
    partialOutput: task.partialOutput,
    error: task.error,
  };
}

export function registerTaskRoutes(
  app: FastifyInstance,
  taskService: TaskService | undefined,
): void {
  app.setErrorHandler((cause, _request, reply) => {
    if (cause instanceof TaskValidationError) {
      void reply.code(400).send({ error: cause.message });
      return;
    }
    if (cause instanceof TaskNotFoundError) {
      void reply.code(404).send({ error: cause.message });
      return;
    }
    if (cause instanceof TaskConflictError) {
      void reply.code(409).send({ error: cause.message });
      return;
    }
    if (cause instanceof ToolRequestNotFoundError) {
      void reply.code(404).send({ error: cause.message });
      return;
    }
    if (cause instanceof ToolRequestConflictError) {
      void reply.code(409).send({ error: cause.message });
      return;
    }
    if ((cause as { validation?: unknown }).validation) {
      void reply.code(400).send({ error: 'Request body does not match the API contract.' });
      return;
    }
    void reply.code(500).send({ error: 'Internal runtime error.' });
  });

  app.post('/v1/tasks', { schema: { body: createTaskSchema } }, async (request, reply) => {
    if (!taskService) return unavailable(reply);
    const task = taskService.createTask(request.body);
    taskService.startTask(task.id);
    reply.code(202);
    return { task: toTaskResponse(task) };
  });

  app.get('/v1/tasks', async (_request, reply) => {
    if (!taskService) return unavailable(reply);
    return {
      tasks: taskService.store.listTasks().map(toTaskResponse),
      activeConfigurationRevisionId: taskService.activeConfigurationRevisionId,
    };
  });

  app.get<{ Params: { taskId: string } }>('/v1/tasks/:taskId', async (request, reply) => {
    if (!taskService) return unavailable(reply);
    const task = taskService.store.getTask(request.params.taskId);
    if (!task) throw new TaskNotFoundError();
    return { task: toTaskResponse(task) };
  });

  app.post<{ Params: { taskId: string } }>(
    '/v1/tasks/:taskId/cancel',
    async (request, reply) => {
      if (!taskService) return unavailable(reply);
      const task = taskService.cancelTask(request.params.taskId);
      return { task: toTaskResponse(task) };
    },
  );

  app.post<{ Params: { taskId: string } }>(
    '/v1/tasks/:taskId/retry',
    async (request, reply) => {
      if (!taskService) return unavailable(reply);
      const task = taskService.retryTask(request.params.taskId);
      taskService.startTask(task.id);
      return { task: toTaskResponse(task), retried: true };
    },
  );
}
