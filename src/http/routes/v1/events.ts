import type { FastifyInstance } from 'fastify';
import { EventOrderError } from '../../../runtime/event-log.js';
import type { TaskService } from '../../../runtime/task-service.js';

const DEFAULT_EVENT_LIMIT = 500;
const MAX_EVENT_LIMIT = 1_000;

const eventsQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    after: { type: 'string', pattern: '^evt_[0-9]{12}$' },
    limit: { type: 'integer', minimum: 1, maximum: MAX_EVENT_LIMIT },
  },
} as const;

export function registerEventRoutes(
  app: FastifyInstance,
  taskService: TaskService | undefined,
): void {
  app.get<{ Querystring: { after?: string; limit?: number } }>(
    '/v1/events',
    { schema: { querystring: eventsQuerySchema } },
    async (request, reply) => {
      if (!taskService) {
        return reply.code(503).send({ error: 'Task service is not configured.' });
      }
      // Unbounded by default used to mean "return the whole log": on a mature
      // instance a single request serialised hundreds of megabytes on the event
      // loop. Paging keeps the response proportional to what was asked for.
      const limit = request.query.limit ?? DEFAULT_EVENT_LIMIT;
      try {
        // Ask for one extra row so `hasMore` reports whether a next page exists
        // instead of whether this page happened to fill up.
        const page = taskService.store.listEvents(request.query.after ?? null, limit + 1);
        const hasMore = page.length > limit;
        const events = hasMore ? page.slice(0, limit) : page;
        return {
          events,
          cursor: events.at(-1)?.id ?? request.query.after ?? null,
          hasMore,
          limit,
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
