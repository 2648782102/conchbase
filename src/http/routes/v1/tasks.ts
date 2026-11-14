import type { FastifyInstance } from 'fastify';
import {
  AgentConflictError,
  AgentNotFoundError,
  AgentValidationError,
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
    agentId: { type: 'string', pattern: '^agt_[a-f0-9]{32}$' },
    modelOverride: {
      type: 'object', additionalProperties: false, required: ['providerId', 'modelId'],
      properties: {
        providerId: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,63}$' },
        modelId: { type: 'string', minLength: 1, maxLength: 300 },
      },
    },
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
  readonly agentId?: string;
  readonly agentRevisionId?: string;
  readonly providerId?: string;
  readonly modelId?: string;
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
    ...(task.agentId ? { agentId: task.agentId } : {}),
    ...(task.agentRevisionId ? { agentRevisionId: task.agentRevisionId } : {}),
    ...(task.providerId ? { providerId: task.providerId } : {}),
    ...(task.modelId ? { modelId: task.modelId } : {}),
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
    const statusCode = (cause as { statusCode?: unknown }).statusCode;
    if (statusCode === 400) {
      void reply.code(400).send({ error: 'Request body does not match the API contract.' });
      return;
    }
    void reply.code(500).send({ error: 'Internal runtime error.' });
  });

  app.post('/v1/tasks', { schema: { body: createTaskSchema } }, async (request, reply) => {
    if (!taskService) return unavailable(reply);
    const body = request.body as { agentId?: unknown; model?: unknown; modelOverride?: unknown };
    if (body.agentId === undefined && body.modelOverride !== undefined) {
      return reply.code(400).send({ error: 'modelOverride requires agentId.' });
    }
    if (body.agentId !== undefined) {
      if (body.model !== undefined) {
        return reply.code(400).send({ error: 'Agent-backed tasks cannot include legacy model.' });
      }
      let agentTask;
      try { agentTask = await taskService.createAgentTask(request.body); }
      catch (cause) {
        if (cause instanceof TaskValidationError) return reply.code(400).send({ error: cause.message });
        if (cause instanceof TaskNotFoundError) return reply.code(404).send({ error: cause.message });
        if (cause instanceof TaskConflictError) return reply.code(409).send({ error: cause.message });
        if (cause instanceof AgentValidationError) return reply.code(400).send({ error: cause.message });
        if (cause instanceof AgentNotFoundError) return reply.code(404).send({ error: cause.message });
        if (cause instanceof AgentConflictError) return reply.code(409).send({ error: cause.message });
        throw cause;
      }
      taskService.startTask(agentTask.id);
      reply.code(202);
      return { task: toTaskResponse(agentTask) };
    }
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

  app.post<{ Params: { taskId: string } }>(
    '/v1/tasks/:taskId/approval',
    async (request, reply) => {
      if (!taskService) return unavailable(reply);
      const body = request.body as { readonly decision?: unknown } | undefined;
      if (body?.decision !== 'approved' && body?.decision !== 'rejected') {
        return reply.code(400).send({ error: 'decision must be approved or rejected.' });
      }
      const task = taskService.decideApproval(request.params.taskId, body.decision);
      return { task: toTaskResponse(task) };
    },
  );
}
