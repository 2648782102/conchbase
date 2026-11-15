import type { FastifyInstance } from 'fastify';
import type { AgentMemoryStore, MemoryScope } from '../../../runtime/agent-memory.js';
import { MEMORY_SCOPES } from '../../../runtime/agent-memory.js';

export const MEMORY_PUBLIC_CONTRACT_VERSION = '1.9.0';

export const MEMORY_PUBLIC_PATHS = Object.freeze([
  '/v1/memory',
  '/v1/memory/{memoryId}',
] as const);

export const MEMORY_PUBLIC_PATH_COUNT = MEMORY_PUBLIC_PATHS.length;

const MAX_LIST = 200;

function unavailable(reply: { code(status: number): { send(payload: unknown): unknown } }) {
  return reply.code(503).send({ error: 'Memory is not configured.' });
}

/**
 * Read and retract memory.
 *
 * There is deliberately no write route. Memory content may only enter through
 * the Runtime's own validation path, so a client cannot inject a fact that the
 * Boss will later treat as recollection.
 */
export function registerMemoryRoutes(app: FastifyInstance, memory?: AgentMemoryStore): void {
  app.get<{
    Querystring: { scope?: string; scopeId?: string; limit?: string };
  }>('/v1/memory', async (request, reply) => {
    if (!memory) return unavailable(reply);
    const { scope, scopeId, limit } = request.query;
    if (scope !== undefined && !MEMORY_SCOPES.includes(scope as MemoryScope)) {
      return reply.code(400).send({ error: 'scope must be runtime, project, or agent.' });
    }
    let boundedLimit = 50;
    if (limit !== undefined) {
      const parsed = Number(limit);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIST) {
        return reply.code(400).send({ error: `limit must be an integer from 1 to ${MAX_LIST}.` });
      }
      boundedLimit = parsed;
    }
    const entries = memory.list({
      ...(scope === undefined ? {} : { scope: scope as MemoryScope }),
      ...(scopeId === undefined ? {} : { scopeId }),
      limit: boundedLimit,
    });
    return reply.send({
      version: MEMORY_PUBLIC_CONTRACT_VERSION,
      entries: entries.map((entry) => Object.freeze({
        id: entry.id,
        scope: entry.scope,
        scopeId: entry.scopeId,
        key: entry.key,
        title: entry.title,
        body: entry.body,
        sourceIntentId: entry.sourceIntentId,
        reviewedBy: entry.reviewedBy,
        createdAt: entry.createdAt,
      })),
    });
  });

  app.delete<{ Params: { memoryId: string } }>('/v1/memory/:memoryId', async (request, reply) => {
    if (!memory) return unavailable(reply);
    const removed = memory.remove(request.params.memoryId);
    if (!removed) return reply.code(404).send({ error: 'Memory entry not found.' });
    return reply.code(200).send({
      version: MEMORY_PUBLIC_CONTRACT_VERSION,
      memoryId: request.params.memoryId,
      removed: true,
    });
  });
}
