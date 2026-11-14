import type { FastifyInstance } from 'fastify';
import {
  AGENT_CHAT_CONTRACT_VERSION,
  AgentChatService,
  AgentChatServiceError,
} from '../../../runtime/agent-chat.js';

function unavailable(reply: { code(status: number): { send(payload: unknown): unknown } }) {
  return reply.code(503).send({ error: 'Agent Chat is not configured.' });
}

function errorResponse(
  reply: { code(status: number): { send(payload: unknown): unknown } },
  cause: unknown,
) {
  const status = cause instanceof AgentChatServiceError ? cause.statusCode : 400;
  const message = cause instanceof Error ? cause.message : 'Agent Chat request was rejected.';
  return reply.code(status).send({
    error: message.slice(0, 240).replace(/[\u0000-\u001f\u007f]/g, ' '),
  });
}

export function registerAgentChatRoutes(
  app: FastifyInstance,
  service: AgentChatService | undefined,
): void {
  app.get('/v1/agent-chat/agents', async (_request, reply) => {
    if (!service) return unavailable(reply);
    try {
      return reply.send({
        version: AGENT_CHAT_CONTRACT_VERSION,
        agents: service.listAgents(),
      });
    } catch (cause) {
      return errorResponse(reply, cause);
    }
  });

  app.post('/v1/agent-chat/conversations', async (request, reply) => {
    if (!service) return unavailable(reply);
    try {
      return reply.code(201).send(await service.createConversation(request.body));
    } catch (cause) {
      return errorResponse(reply, cause);
    }
  });

  app.get<{ Querystring: { limit?: string } }>('/v1/agent-chat/conversations', async (request, reply) => {
    if (!service) return unavailable(reply);
    try {
      const raw = request.query?.limit;
      const limit = raw === undefined ? 20 : Number(raw);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
        return reply.code(400).send({ error: 'limit must be an integer between 1 and 50.' });
      }
      return reply.send(await service.listConversations(limit));
    } catch (cause) {
      return errorResponse(reply, cause);
    }
  });

  app.get<{ Params: { conversationId: string } }>(
    '/v1/agent-chat/conversations/:conversationId',
    async (request, reply) => {
      if (!service) return unavailable(reply);
      try {
        return reply.send(service.view(request.params.conversationId));
      } catch (cause) {
        return errorResponse(reply, cause);
      }
    },
  );

  app.post<{ Params: { conversationId: string } }>(
    '/v1/agent-chat/conversations/:conversationId/messages',
    async (request, reply) => {
      if (!service) return unavailable(reply);
      try {
        const result = await service.postMessage(request.params.conversationId, request.body);
        return reply.code(202).send(result);
      } catch (cause) {
        return errorResponse(reply, cause);
      }
    },
  );
}
