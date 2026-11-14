import type { FastifyInstance } from 'fastify';
import {
  AGENT_CHAT_CONTRACT_VERSION,
  AgentChatService,
  AgentChatServiceError,
} from '../../../runtime/agent-chat.js';
import type { AgentChatStreamFrame } from '../../../runtime/agent-chat.js';
import { EventOrderError } from '../../../runtime/event-log.js';

const STREAM_INTERVAL_MS = 300;
const HEARTBEAT_MS = 15_000;
const REPLAY_LIMIT = 500;

function frameText(frame: AgentChatStreamFrame): string {
  return [
    ...(frame.eventId === null ? [] : [`id: ${frame.eventId}`]),
    'event: agent-chat',
    `data: ${JSON.stringify(frame)}`,
    '',
    '',
  ].join('\n');
}

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

  app.post<{ Params: { conversationId: string } }>(
    '/v1/agent-chat/conversations/:conversationId/approval',
    async (request, reply) => {
      if (!service) return unavailable(reply);
      try {
        const result = service.decideApproval(request.params.conversationId, request.body);
        return reply.send(result);
      } catch (cause) {
        return errorResponse(reply, cause);
      }
    },
  );

  app.get<{ Params: { conversationId: string }; Querystring: { after?: string } }>(
    '/v1/agent-chat/conversations/:conversationId/events',
    async (request, reply) => {
      if (!service) return unavailable(reply);
      const conversationId = request.params.conversationId;
      const headerCursor = request.headers['last-event-id'];
      const after = typeof headerCursor === 'string' && headerCursor.length > 0
        ? headerCursor
        : request.query.after;
      if (after !== undefined && !/^evt_[0-9]{12}$/.test(after)) {
        return errorResponse(reply, new AgentChatServiceError('after must be an event id.'));
      }

      let taskIds: readonly string[];
      try {
        taskIds = service.conversationTaskIds(conversationId);
      } catch (cause) {
        return errorResponse(reply, cause);
      }
      if (after !== undefined) {
        try {
          const known = service.taskService.store.getEvent(after);
          if (!known || !taskIds.includes(known.taskId)) {
            return errorResponse(reply, new AgentChatServiceError('after must belong to this conversation.'));
          }
        } catch (cause) {
          if (cause instanceof EventOrderError) {
            return errorResponse(reply, new AgentChatServiceError('Unknown event cursor.'));
          }
          return errorResponse(reply, cause);
        }
      }

      reply.hijack();
      const response = reply.raw;
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      let closed = false;
      let cursor = after ?? null;
      let revision = service.conversationRevision(conversationId);
      const sent = new Map<string, string>();
      let interval: NodeJS.Timeout | null = null;
      let heartbeat: NodeJS.Timeout | null = null;

      const close = () => {
        if (closed) return;
        closed = true;
        if (interval !== null) clearInterval(interval);
        if (heartbeat !== null) clearInterval(heartbeat);
        response.end();
      };
      const write = (frame: AgentChatStreamFrame) => {
        if (closed) return;
        if (frame.eventId !== null) cursor = frame.eventId;
        if (frame.kind === 'message' && frame.messageId !== null) {
          const fingerprint = JSON.stringify(frame.message);
          if (sent.get(frame.messageId) === fingerprint) return;
          sent.set(frame.messageId, fingerprint);
          if (sent.size > 64) {
            const oldest = sent.keys().next().value;
            if (oldest !== undefined) sent.delete(oldest);
          }
        }
        response.write(frameText(frame));
      };
      request.raw.on('close', close);
      request.raw.on('error', close);

      write(service.snapshotFrame(conversationId, cursor));

      try {
        const replayed = service.taskService.store.listEvents(cursor)
          .filter((event) => taskIds.includes(event.taskId))
          .slice(0, REPLAY_LIMIT);
        for (const event of replayed) {
          const frame = service.eventFrame(conversationId, event.id, event.taskId);
          if (frame) write(frame);
        }
      } catch (cause) {
        close();
        if (!(cause instanceof EventOrderError)) throw cause;
        return;
      }

      interval = setInterval(() => {
        if (closed) return;
        try {
          const latestTaskIds = service.conversationTaskIds(conversationId);
          const newTaskIds = latestTaskIds.filter((taskId) => !taskIds.includes(taskId));
          if (newTaskIds.length > 0) taskIds = latestTaskIds;
          const latestRevision = service.conversationRevision(conversationId);
          if (latestRevision !== revision) {
            revision = latestRevision;
            const current = service.view(conversationId);
            const last = current.messages.at(-1);
            if (last) {
              write({
                version: AGENT_CHAT_CONTRACT_VERSION,
                conversationId,
                kind: 'message',
                eventId: cursor,
                messageId: last.id,
                message: last,
                conversation: null,
              });
            }
          }
          const next = service.taskService.store.listEvents(cursor)
            .filter((event) => taskIds.includes(event.taskId));
          for (const event of next) {
            const frame = service.eventFrame(conversationId, event.id, event.taskId);
            if (frame) write(frame);
            else cursor = event.id;
          }
        } catch (cause) {
          if (cause instanceof EventOrderError) {
            write(service.snapshotFrame(conversationId, cursor));
            return;
          }
          close();
        }
      }, STREAM_INTERVAL_MS);
      interval.unref?.();

      heartbeat = setInterval(() => {
        if (!closed) response.write(': ping\n\n');
      }, HEARTBEAT_MS);
      heartbeat.unref?.();
    },
  );
}
