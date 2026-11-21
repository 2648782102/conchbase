import type { FastifyInstance } from 'fastify';
import {
  ScheduleValidationError,
  parseScheduleInput,
  SCHEDULE_CONTRACT_VERSION,
  type ScheduleStore,
} from '../../../runtime/schedule.js';
import type { TaskService } from '../../../runtime/task-service.js';

export const SCHEDULE_PUBLIC_PATHS = Object.freeze([
  '/v1/schedules',
  '/v1/schedules/{scheduleId}',
] as const);

/**
 * Recurring tasks, as data.
 *
 * A schedule names an Agent and a prompt; creating one here grants nothing. The
 * task it later produces is pinned to the Agent's revision exactly like a task
 * the user typed, including its capability grants and approval policy.
 */
export function registerScheduleRoutes(
  app: FastifyInstance,
  taskService: TaskService | undefined,
): void {
  // A caller may inject a partial store (tests, embedders); an absent schedule
  // table must degrade to 503, not throw while routes are being registered.
  const store = taskService?.store?.schedules;
  const unavailable = (reply: { code(status: number): { send(payload: unknown): unknown } }) =>
    reply.code(503).send({ error: 'Schedules are not configured.' });

  const errorResponse = (
    reply: { code(status: number): { send(payload: unknown): unknown } },
    cause: unknown,
  ) => {
    if (cause instanceof ScheduleValidationError) {
      return reply.code(400).send({ error: cause.message.slice(0, 240) });
    }
    return reply.code(400).send({
      error: cause instanceof Error ? cause.message.slice(0, 240) : 'Schedule request was rejected.',
    });
  };

  app.get('/v1/schedules', async (_request, reply) => {
    if (!store) return unavailable(reply);
    return reply.send({ version: SCHEDULE_CONTRACT_VERSION, schedules: store.list() });
  });

  app.post('/v1/schedules', async (request, reply) => {
    if (!store || !taskService) return unavailable(reply);
    try {
      const now = new Date().toISOString();
      const input = parseScheduleInput(request.body, now);
      /*
       * The Agent must exist and be usable now, not at firing time.
       *
       * Validating only when it fires would mean an operator learns about a
       * typo days later, from a disabled schedule instead of a rejected request.
       */
      taskService.getAgent(input.agentId);
      const schedule = store.create(input, now);
      return reply.code(201).send({ version: SCHEDULE_CONTRACT_VERSION, schedule });
    } catch (cause) {
      return errorResponse(reply, cause);
    }
  });

  app.get<{ Params: { scheduleId: string } }>('/v1/schedules/:scheduleId', async (request, reply) => {
    if (!store) return unavailable(reply);
    const schedule = store.get(request.params.scheduleId);
    if (!schedule) return reply.code(404).send({ error: 'Schedule not found.' });
    return reply.send({ version: SCHEDULE_CONTRACT_VERSION, schedule });
  });

  app.patch<{ Params: { scheduleId: string } }>('/v1/schedules/:scheduleId', async (request, reply) => {
    if (!store) return unavailable(reply);
    if (!store.get(request.params.scheduleId)) return reply.code(404).send({ error: 'Schedule not found.' });
    const body = request.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return reply.code(400).send({ error: 'Body must be an object.' });
    }
    const record = body as Record<string, unknown>;
    const unknown = Object.keys(record).filter((key) => key !== 'enabled');
    if (unknown.length > 0) return reply.code(400).send({ error: `Unknown fields: ${unknown.sort().join(', ')}.` });
    if (typeof record.enabled !== 'boolean') {
      return reply.code(400).send({ error: 'enabled must be a boolean.' });
    }
    return reply.send({
      version: SCHEDULE_CONTRACT_VERSION,
      schedule: store.update(request.params.scheduleId, { enabled: record.enabled }),
    });
  });

  app.delete<{ Params: { scheduleId: string } }>('/v1/schedules/:scheduleId', async (request, reply) => {
    if (!store) return unavailable(reply);
    if (!store.remove(request.params.scheduleId)) {
      return reply.code(404).send({ error: 'Schedule not found.' });
    }
    return reply.code(200).send({ version: SCHEDULE_CONTRACT_VERSION, removed: true });
  });
}

export type { ScheduleStore };
export { SCHEDULE_CONTRACT_VERSION };
