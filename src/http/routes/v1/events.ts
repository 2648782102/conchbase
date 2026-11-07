import type { FastifyInstance } from 'fastify';
import { EventOrderError } from '../../../runtime/event-log.js';
import type { TaskService } from '../../../runtime/task-service.js';

const eventsQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    after: { type: 'string', pattern: '^evt_[0-9]{12}$' },
  },
} as const;

export function registerEventRoutes(
  app: FastifyInstance,
  taskService: TaskService | undefined,
): void {
  app.get<{ Querystring: { after?: string } }>(
    '/v1/events',
    { schema: { querystring: eventsQuerySchema } },
    async (request, reply) => {
      if (!taskService) {
        return reply.code(503).send({ error: 'Task service is not configured.' });
      }
      try {
        const events = taskService.store.listEvents(request.query.after ?? null);
        return {
          events,
          cursor: events.at(-1)?.id ?? request.query.after ?? null,
        };
      } catch (cause) {
        if (cause instanceof EventOrderError) {
          return reply.code(400).send({ error: 'Unknown event cursor.' });
        }
        throw cause;
      }
    },
  );
}
