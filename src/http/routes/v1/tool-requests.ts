import type { FastifyInstance } from 'fastify';
import {
  ToolRequestConflictError,
  ToolRequestContextError,
  ToolRequestNotFoundError,
  ToolRequestValidationError,
} from '../../../runtime/task-service.js';
import type { TaskService } from '../../../runtime/task-service.js';

const createRequestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['taskId', 'attempt', 'compositionNodeId', 'toolCall'],
  properties: {
    taskId: { type: 'string', minLength: 1, maxLength: 200 },
    attempt: { type: 'integer', minimum: 1 },
    compositionNodeId: { type: 'string', minLength: 1, maxLength: 128 },
    toolCall: {
      type: 'object',
      additionalProperties: false,
      required: ['toolName', 'arguments'],
      properties: {
        toolName: { type: 'string', minLength: 1, maxLength: 64 },
        arguments: { type: 'object', maxProperties: 8 },
      },
    },
  },
} as const;

const decisionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['decision', 'reason'],
  properties: {
    decision: { type: 'string', enum: ['approved', 'rejected'] },
    reason: { type: 'string', minLength: 1, maxLength: 500 },
  },
} as const;

function unavailable(reply: {
  code(status: number): { send(payload: unknown): unknown };
}) {
  return reply.code(503).send({ error: 'Task service is not configured.' });
}

export function registerToolRequestRoutes(
  app: FastifyInstance,
  taskService: TaskService | undefined,
): void {
  app.post('/v1/tool-requests', { schema: { body: createRequestSchema } }, async (request, reply) => {
    if (!taskService) return unavailable(reply);
    try {
      const result = taskService.createToolRequest(request.body);
      reply.code(result.created ? 201 : 200);
      return { request: result.request, created: result.created };
    } catch (cause) {
      if (cause instanceof ToolRequestValidationError) {
        return reply.code(400).send({ error: cause.message, details: cause.details });
      }
      if (cause instanceof ToolRequestContextError) {
        return reply.code(409).send({ error: cause.message });
      }
      throw cause;
    }
  });

  app.get<{ Params: { requestId: string } }>(
    '/v1/tool-requests/:requestId',
    async (request, reply) => {
      if (!taskService) return unavailable(reply);
      try {
        return { request: taskService.getToolRequest(request.params.requestId) };
      } catch (cause) {
        if (cause instanceof ToolRequestNotFoundError) {
          return reply.code(404).send({ error: cause.message });
        }
        throw cause;
      }
    },
  );

  app.post<{ Params: { requestId: string } }>(
    '/v1/tool-requests/:requestId/approval',
    { schema: { body: decisionSchema } },
    async (request, reply) => {
      if (!taskService) return unavailable(reply);
      try {
        const result = taskService.decideToolRequest(request.params.requestId, request.body);
        reply.code(result.changed ? 201 : 200);
        return { request: result.request, changed: result.changed };
      } catch (cause) {
        if (cause instanceof ToolRequestValidationError) {
          return reply.code(400).send({ error: cause.message, details: cause.details });
        }
        if (cause instanceof ToolRequestNotFoundError) {
          return reply.code(404).send({ error: cause.message });
        }
        if (cause instanceof ToolRequestConflictError) {
          return reply.code(409).send({ error: cause.message });
        }
        throw cause;
      }
    },
  );
}
