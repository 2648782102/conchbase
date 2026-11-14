import type { FastifyInstance } from 'fastify';
import {
  EXECUTION_RUN_CONTRACT_VERSION,
  EXECUTION_RUN_PUBLIC_PATHS,
  ExecutionRunConflictError,
  ExecutionRunNotFoundError,
  ExecutionRunValidationError,
  IsolatedExecutionService,
} from '../../../runtime/isolated-execution.js';

function envelope(value: unknown) {
  return { version: EXECUTION_RUN_CONTRACT_VERSION, ...Object(value) };
}

function errorStatus(cause: unknown): number {
  if (cause instanceof ExecutionRunNotFoundError) return 404;
  if (cause instanceof ExecutionRunConflictError) return 409;
  return 400;
}

function errorResponse(reply: { code(status: number): { send(payload: unknown): unknown } }, cause: unknown) {
  const message = cause instanceof Error ? cause.message : 'Execution run request was rejected.';
  return reply.code(errorStatus(cause)).send({
    error: message.slice(0, 240).replace(/[\u0000-\u001f\u007f]/g, ' '),
  });
}

function parseBody(value: unknown): unknown {
  if (typeof value === 'string') return JSON.parse(value);
  return value;
}

function limitFromQuery(value: unknown): number {
  if (value === undefined) return 100;
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw new ExecutionRunValidationError('limit must be an integer from 1 to 1000.');
  }
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new ExecutionRunValidationError('limit must be an integer from 1 to 1000.');
  }
  return limit;
}

export function registerExecutionRunRoutes(
  app: FastifyInstance,
  service: IsolatedExecutionService | undefined,
): void {
  void app.register(async (scope) => {
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
      done(null, body);
    });

    const unavailable = (reply: { code(status: number): { send(payload: unknown): unknown } }) =>
      reply.code(503).send({ error: 'Isolated execution service is not configured.' });

    scope.get('/v1/execution/run-health', async (_request, reply) => {
      if (!service) return unavailable(reply);
      return reply.send({
        version: EXECUTION_RUN_CONTRACT_VERSION,
        status: 'ready',
        paths: EXECUTION_RUN_PUBLIC_PATHS,
      });
    });

    scope.get('/v1/execution/adapters', async (_request, reply) => {
      if (!service) return unavailable(reply);
      return reply.send(envelope({ adapters: service.get().adapters }));
    });

    scope.get('/v1/execution/runs', async (_request, reply) => {
      if (!service) return unavailable(reply);
      return reply.send(envelope({ runs: service.get().runs }));
    });

    scope.post('/v1/execution/runs', async (request, reply) => {
      if (!service) return unavailable(reply);
      try {
        const run = service.createRun(parseBody(request.body));
        return reply.code(201).send(envelope({ run }));
      } catch (cause) {
        return errorResponse(reply, cause);
      }
    });

    scope.get<{ Params: { runId: string } }>(
      '/v1/execution/runs/:runId',
      async (request, reply) => {
        if (!service) return unavailable(reply);
        try {
          return reply.send(envelope({ run: service.getRun(request.params.runId) }));
        } catch (cause) {
          return errorResponse(reply, cause);
        }
      },
    );

    for (const action of ['start', 'cancel', 'recover'] as const) {
      scope.post<{ Params: { runId: string } }>(
        `/v1/execution/runs/:runId/${action}`,
        async (request, reply) => {
          if (!service) return unavailable(reply);
          try {
            const body = parseBody(request.body) as Record<string, unknown>;
            const input = { ...body, runId: request.params.runId };
            const run = action === 'start'
              ? await service.startRun(input)
              : action === 'cancel'
                ? service.cancelRun(input)
                : service.recoverRun(input);
            return reply.send(envelope({ run }));
          } catch (cause) {
            return errorResponse(reply, cause);
          }
        },
      );
    }

    scope.get<{ Params: { runId: string }; Querystring: { after?: string; limit?: string } }>(
      '/v1/execution/runs/:runId/events',
      async (request, reply) => {
        if (!service) return unavailable(reply);
        try {
          service.getRun(request.params.runId);
          const after = request.query.after;
          const limit = limitFromQuery(request.query.limit);
          const events = service.runEvents(after, limit).filter((event) =>
            event.data.runId === request.params.runId || event.type === 'execution.run_interrupted');
          return reply.send(envelope({
            events,
            nextCursor: events.length === 0 ? null : events[events.length - 1]!.id,
            hasMore: false,
          }));
        } catch (cause) {
          return errorResponse(reply, cause);
        }
      },
    );
  });
}
