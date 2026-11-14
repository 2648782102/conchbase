import type { FastifyInstance } from 'fastify';
import type { OrganizationStore } from '../../../runtime/organization-store.js';
import type { PrimaryConversationService } from '../../../runtime/primary-conversation.js';
import type { ConversationTaskState } from '../../../runtime/primary-conversation.js';

function unavailable(reply: { code(status: number): { send(payload: unknown): unknown } }) {
  return reply.code(503).send({ error: 'Primary conversation is not configured.' });
}

function boundedLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error('limit must be an integer between 1 and 200.');
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
    throw new Error('limit must be an integer between 1 and 200.');
  }
  return parsed;
}

function taskStatesFrom(raw: unknown): readonly ConversationTaskState[] {
  if (!Array.isArray(raw)) return [];
  return Object.freeze(raw.flatMap((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    return typeof record.taskId === 'string' && typeof record.state === 'string'
      && typeof record.attempt === 'number' && Number.isInteger(record.attempt)
      ? [{ taskId: record.taskId, state: record.state, attempt: record.attempt }]
      : [];
  }));
}

export function registerConversationRoutes(
  app: FastifyInstance,
  organizationStore: OrganizationStore | undefined,
  conversation: PrimaryConversationService | undefined,
  listTaskStates?: () => readonly ConversationTaskState[],
): void {
  app.get('/v1/organization/conversation', async (request, reply) => {
    if (!organizationStore || !conversation) return unavailable(reply);
    try {
      const query = (request.query ?? {}) as Record<string, unknown>;
      const limit = boundedLimit(query.limit);
      return reply.send(conversation.view(organizationStore.get(), {
        ...(limit === undefined ? {} : { limit }),
        taskStates: listTaskStates?.() ?? taskStatesFrom(query.taskStates),
      }));
    } catch (cause) {
      return reply.code(400).send({
        error: cause instanceof Error ? cause.message.slice(0, 240) : 'Conversation request was rejected.',
      });
    }
  });

  app.get('/v1/organization/conversation/messages', async (request, reply) => {
    if (!organizationStore || !conversation) return unavailable(reply);
    try {
      const query = (request.query ?? {}) as Record<string, unknown>;
      const after = typeof query.after === 'string' ? query.after : null;
      const limit = boundedLimit(query.limit);
      return reply.send(conversation.page(organizationStore.get(), {
        ...(after === null ? {} : { after }),
        ...(limit === undefined ? {} : { limit }),
        taskStates: listTaskStates?.() ?? taskStatesFrom(query.taskStates),
      }));
    } catch (cause) {
      return reply.code(400).send({
        error: cause instanceof Error ? cause.message.slice(0, 240) : 'Conversation request was rejected.',
      });
    }
  });
}
