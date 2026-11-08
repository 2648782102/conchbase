import type { FastifyInstance } from 'fastify';
import {
  ConfigurationValidationError,
  ConfigurationRevisionNotFoundError,
} from '../../../runtime/task-service.js';
import type { TaskService } from '../../../runtime/task-service.js';

const validateRequestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['document'],
  properties: {
    document: { type: 'object' },
  },
} as const;

const applyRequestSchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  maxProperties: 1,
  properties: {
    document: { type: 'object' },
    rollbackTo: { type: 'string', pattern: '^cfg_[0-9a-f]{24}$' },
  },
} as const;

const revisionParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['revisionId'],
  properties: {
    revisionId: { type: 'string', pattern: '^cfg_[0-9a-f]{24}$' },
  },
} as const;

function unavailable(reply: {
  code(status: number): { send(payload: unknown): unknown };
}) {
  return reply.code(503).send({ error: 'Task service is not configured.' });
}

export function registerConfigurationRoutes(
  app: FastifyInstance,
  taskService: TaskService | undefined,
): void {
  app.get('/v1/configuration', async (_request, reply) => {
    if (!taskService) return unavailable(reply);
    const state = taskService.getConfigurationState();
    return { revision: state.active };
  });

  app.get('/v1/configuration/revisions', async (_request, reply) => {
    if (!taskService) return unavailable(reply);
    const state = taskService.getConfigurationState();
    return {
      activeRevisionId: state.active.id,
      revisions: state.history,
    };
  });

  app.get<{ Params: { revisionId: string } }>(
    '/v1/configuration/revisions/:revisionId',
    { schema: { params: revisionParamsSchema } },
    async (request, reply) => {
      if (!taskService) return unavailable(reply);
      try {
        return { revision: taskService.getConfigurationRevision(request.params.revisionId) };
      } catch (cause) {
        if (cause instanceof ConfigurationRevisionNotFoundError) {
          return reply.code(404).send({ error: cause.message });
        }
        throw cause;
      }
    },
  );

  app.post(
    '/v1/configuration/validate',
    { schema: { body: validateRequestSchema } },
    async (request, reply) => {
      if (!taskService) return unavailable(reply);
      const body = request.body as { document: unknown };
      try {
        const document = taskService.validateConfiguration(body.document);
        return {
          valid: true,
          activeRevisionId: taskService.getConfigurationState().active.id,
          document,
        };
      } catch (cause) {
        if (cause instanceof ConfigurationValidationError) {
          return reply.code(400).send({
            error: cause.message,
            details: cause.details,
          });
        }
        throw cause;
      }
    },
  );

  app.post(
    '/v1/configuration/apply',
    { schema: { body: applyRequestSchema } },
    async (request, reply) => {
      if (!taskService) return unavailable(reply);
      const body = request.body as Record<string, unknown>;
      try {
        const result = taskService.applyConfiguration(body);
        return {
          changed: result.changed,
          activeRevisionId: result.state.active.id,
          revision: result.state.active,
          revisions: result.state.history,
        };
      } catch (cause) {
        if (cause instanceof ConfigurationValidationError) {
          return reply.code(400).send({
            error: cause.message,
            details: cause.details,
          });
        }
        if (cause instanceof ConfigurationRevisionNotFoundError) {
          return reply.code(404).send({ error: cause.message });
        }
        throw cause;
      }
    },
  );
}
