import type { FastifyInstance } from 'fastify';

export function registerHealthRoute(app: FastifyInstance): void {
  app.get('/v1/health', async () => ({
    status: 'ok',
    service: 'conchbase',
    apiVersion: 1,
  }));
}
