import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  indexWorkspaceFiles,
  WorkspaceIndexError,
  WORKSPACE_INDEX_MAX_ENTRIES,
} from '../../../runtime/workspace-index.js';

export const WORKSPACE_INDEX_CAPABILITY = 'workspace-index';
export const WORKSPACE_INDEX_PATHS = Object.freeze(['/v1/workspace/files']);

/**
 * The `@` picker's data source.
 *
 * Read-only and bounded: the client asks for candidate paths, and the Runtime
 * answers from the same root its tools already use. No contents cross this
 * boundary, so this cannot become a file-read shortcut around the tool
 * approval ledger.
 */
export function registerWorkspaceRoutes(app: FastifyInstance, workspaceRoot: string | undefined): void {
  if (!workspaceRoot) return;

  app.get('/v1/workspace/files', async (request, reply) => {
    const query = request.query as { q?: unknown; limit?: unknown } | undefined;
    const rawQuery = typeof query?.q === 'string' ? query.q.slice(0, 200) : '';
    const rawLimit = typeof query?.limit === 'string' ? Number(query.limit) : undefined;
    const limit = rawLimit !== undefined && Number.isFinite(rawLimit)
      ? Math.min(Math.max(Math.trunc(rawLimit), 1), WORKSPACE_INDEX_MAX_ENTRIES)
      : 50;
    try {
      const index = indexWorkspaceFiles(workspaceRoot, { query: rawQuery, limit });
      return {
        version: 1,
        files: index.files,
        truncated: index.truncated,
      };
    } catch (cause) {
      return unavailable(reply, cause);
    }
  });
}

function unavailable(reply: FastifyReply, cause: unknown): unknown {
  if (cause instanceof WorkspaceIndexError) {
    return reply.code(503).send({ error: cause.message, code: cause.code });
  }
  throw cause;
}
