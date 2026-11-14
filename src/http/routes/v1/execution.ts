import type { FastifyInstance } from 'fastify';
import {
  ControlledExecutionService,
  EXECUTION_CONTRACT_VERSION,
  EXECUTION_PUBLIC_PATHS,
  ExecutionConflictError,
  ExecutionNotFoundError,
  ExecutionValidationError,
} from '../../../runtime/controlled-execution.js';

function envelope(value: unknown) {
  return { version: EXECUTION_CONTRACT_VERSION, ...Object(value) };
}

function errorStatus(cause: unknown): number {
  if (cause instanceof ExecutionNotFoundError) return 404;
  if (cause instanceof ExecutionConflictError) return 409;
  return 400;
}

function errorResponse(reply: { code(status: number): { send(payload: unknown): unknown } }, cause: unknown) {
  const message = cause instanceof Error ? cause.message : 'Execution request was rejected.';
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
    throw new ExecutionValidationError('limit must be an integer from 1 to 1000.');
  }
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new ExecutionValidationError('limit must be an integer from 1 to 1000.');
  }
  return limit;
}

export function registerExecutionRoutes(
  app: FastifyInstance,
  service: ControlledExecutionService | undefined,
): void {
  void app.register(async (scope) => {
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
      done(null, body);
    });

    const unavailable = (reply: { code(status: number): { send(payload: unknown): unknown } }) =>
      reply.code(503).send({ error: 'Controlled execution service is not configured.' });

    scope.get('/v1/execution/health', async (_request, reply) => {
      if (!service) return unavailable(reply);
      return reply.send({
        version: EXECUTION_CONTRACT_VERSION,
        status: 'ready',
        paths: EXECUTION_PUBLIC_PATHS,
      });
    });

    scope.get('/v1/execution/capabilities', async (_request, reply) => {
      if (!service) return unavailable(reply);
      return reply.send(envelope({ capabilities: service.get().capabilities }));
    });

    scope.get('/v1/execution/grants', async (_request, reply) => {
      if (!service) return unavailable(reply);
      return reply.send(envelope({ grants: service.get().grants }));
    });

    scope.post('/v1/execution/grants', async (request, reply) => {
      if (!service) return unavailable(reply);
      try {
        const grant = service.createGrant(parseBody(request.body));
        return reply.code(201).send(envelope({ grant }));
      } catch (cause) {
        return errorResponse(reply, cause);
      }
    });

    scope.post<{ Params: { grantId: string } }>(
      '/v1/execution/grants/:grantId/revoke',
      async (request, reply) => {
        if (!service) return unavailable(reply);
        try {
          const body = parseBody(request.body) as Record<string, unknown>;
          if (!body || typeof body !== 'object' || !Number.isInteger(body.expectedVersion)) {
            throw new ExecutionValidationError('expectedVersion must be a positive integer.');
          }
          const grant = service.revokeGrant(request.params.grantId, body.expectedVersion as number);
          return reply.send(envelope({ grant }));
        } catch (cause) {
          return errorResponse(reply, cause);
        }
      },
    );

    scope.post('/v1/execution/requests', async (request, reply) => {
      if (!service) return unavailable(reply);
      try {
        const executionRequest = service.createRequest(parseBody(request.body));
        return reply.code(201).send(envelope({ request: executionRequest }));
      } catch (cause) {
        return errorResponse(reply, cause);
      }
    });

    scope.get<{ Params: { requestId: string } }>(
      '/v1/execution/requests/:requestId',
      async (request, reply) => {
        if (!service) return unavailable(reply);
        try {
          return reply.send(envelope({ request: service.getRequest(request.params.requestId) }));
        } catch (cause) {
          return errorResponse(reply, cause);
        }
      },
    );

    scope.post<{ Params: { requestId: string } }>(
      '/v1/execution/requests/:requestId/decide',
      async (request, reply) => {
        if (!service) return unavailable(reply);
        try {
          const body = parseBody(request.body) as Record<string, unknown>;
          const executionRequest = await service.decideRequest({
            ...body,
            requestId: request.params.requestId,
          });
          return reply.send(envelope({ request: executionRequest }));
        } catch (cause) {
          return errorResponse(reply, cause);
        }
      },
    );

    scope.get<{ Querystring: { after?: string; limit?: string } }>(
      '/v1/execution/events',
      async (request, reply) => {
        if (!service) return unavailable(reply);
        try {
          const after = request.query.after;
          const limit = limitFromQuery(request.query.limit);
          const events = service.events(after, limit);
          return reply.send(envelope({
            events,
            nextCursor: events.length === 0 ? null : events[events.length - 1]!.id,
            hasMore: service.events(after, 1000).length > limit,
          }));
        } catch (cause) {
          return errorResponse(reply, cause);
        }
      },
    );
  });
}
