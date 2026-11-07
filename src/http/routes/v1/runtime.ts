import type { FastifyInstance } from 'fastify';

export function registerRuntimeRoute(app: FastifyInstance): void {
  app.get('/v1/runtime', async () => ({
    name: 'Conchbase',
    version: '0.1.0',
    state: 'ready',
    capabilities: [],
  }));
}
