import type { FastifyInstance } from 'fastify';
import {
  AgentConflictError,
  AgentNotFoundError,
  AgentValidationError,
  type TaskService,
} from '../../../runtime/task-service.js';

const profileProperties = {
  name: { type: 'string', minLength: 1, maxLength: 120 },
  instructions: { type: 'string', maxLength: 20_000 },
  providerId: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,63}$' },
  modelId: { type: 'string', minLength: 1, maxLength: 300 },
} as const;

function replyError(reply: { code(status: number): { send(payload: unknown): unknown } }, cause: unknown) {
  if (cause instanceof AgentValidationError) return reply.code(400).send({ error: cause.message });
  if (cause instanceof AgentNotFoundError) return reply.code(404).send({ error: cause.message });
  if (cause instanceof AgentConflictError) return reply.code(409).send({ error: cause.message });
  return reply.code(500).send({ error: 'Internal runtime error.' });
}

export function registerAgentRoutes(app: FastifyInstance, service: TaskService | undefined): void {
  app.get('/v1/model-catalog', async (_request, reply) => {
    if (!service) return reply.code(503).send({ error: 'Task service is not configured.' });
    try {
      return { models: await service.listProviderModels() };
    } catch {
      return reply.code(502).send({ error: 'Provider model catalog is unavailable.' });
    }
  });

  app.get('/v1/agents', async (_request, reply) => {
    if (!service) return reply.code(503).send({ error: 'Task service is not configured.' });
    return { agents: service.listAgents() };
  });

  app.post('/v1/agents', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['name', 'instructions', 'providerId', 'modelId'], properties: profileProperties } },
  }, async (request, reply) => {
    if (!service) return reply.code(503).send({ error: 'Task service is not configured.' });
    try {
      reply.code(201);
      return { agent: await service.createAgent(request.body) };
    } catch (cause) { return replyError(reply, cause); }
  });

  app.get<{ Params: { agentId: string } }>('/v1/agents/:agentId', async (request, reply) => {
    if (!service) return reply.code(503).send({ error: 'Task service is not configured.' });
    try { return { agent: service.getAgent(request.params.agentId) }; }
    catch (cause) { return replyError(reply, cause); }
  });

  app.patch<{ Params: { agentId: string } }>('/v1/agents/:agentId', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['expectedRevisionId', 'profile'],
        properties: {
          expectedRevisionId: { type: 'string', pattern: '^agr_[a-zA-Z0-9_-]{1,64}$' },
          profile: { type: 'object', additionalProperties: false, required: ['name', 'instructions', 'providerId', 'modelId'], properties: profileProperties },
        },
      },
    },
  }, async (request, reply) => {
    if (!service) return reply.code(503).send({ error: 'Task service is not configured.' });
    try { return { agent: await service.updateAgent(request.params.agentId, request.body) }; }
    catch (cause) { return replyError(reply, cause); }
  });

  app.post<{ Params: { agentId: string } }>('/v1/agents/:agentId/duplicate', async (request, reply) => {
    if (!service) return reply.code(503).send({ error: 'Task service is not configured.' });
    try {
      reply.code(201);
      return { agent: await service.duplicateAgent(request.params.agentId, request.body) };
    } catch (cause) { return replyError(reply, cause); }
  });

  app.post<{ Params: { agentId: string } }>('/v1/agents/:agentId/archive', async (request, reply) => {
    if (!service) return reply.code(503).send({ error: 'Task service is not configured.' });
    try { return { agent: service.archiveAgent(request.params.agentId) }; }
    catch (cause) { return replyError(reply, cause); }
  });

  app.get<{ Params: { agentId: string } }>('/v1/agents/:agentId/revisions', async (request, reply) => {
    if (!service) return reply.code(503).send({ error: 'Task service is not configured.' });
    try { return { agentId: request.params.agentId, revisions: service.getAgent(request.params.agentId).revisions }; }
    catch (cause) { return replyError(reply, cause); }
  });

  app.post<{ Params: { agentId: string } }>('/v1/agents/:agentId/revisions/apply', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['revisionId', 'expectedRevisionId'], properties: {
      revisionId: { type: 'string', pattern: '^agr_[a-zA-Z0-9_-]{1,64}$' },
      expectedRevisionId: { type: 'string', pattern: '^agr_[a-zA-Z0-9_-]{1,64}$' },
    } } },
  }, async (request, reply) => {
    if (!service) return reply.code(503).send({ error: 'Task service is not configured.' });
    try {
      const body = request.body as { revisionId: string; expectedRevisionId: string };
      return { agent: service.applyAgentRevision(request.params.agentId, body.revisionId, body.expectedRevisionId) };
    }
    catch (cause) { return replyError(reply, cause); }
  });

  app.get('/v1/agents/default', async (_request, reply) => {
    if (!service) return reply.code(503).send({ error: 'Task service is not configured.' });
    const agent = service.listAgents().find((item) => item.isDefault) ?? null;
    return { agent };
  });

  app.put('/v1/agents/default', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['agentId'], properties: {
      agentId: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] },
    } } },
  }, async (request, reply) => {
    if (!service) return reply.code(503).send({ error: 'Task service is not configured.' });
    try {
      const body = request.body as { agentId: string | null };
      service.setDefaultAgent(body.agentId);
      return { agent: body.agentId ? service.getAgent(body.agentId) : null };
    } catch (cause) { return replyError(reply, cause); }
  });
}
