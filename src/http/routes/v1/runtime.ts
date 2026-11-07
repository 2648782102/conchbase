import type { FastifyInstance } from 'fastify';

export function registerRuntimeRoute(app: FastifyInstance, tasksEnabled = false): void {
  app.get('/v1/runtime', async () => ({
    name: 'Conchbase',
    version: '0.3.0',
    state: 'ready',
    capabilities: tasksEnabled
      ? ['tasks', 'events', 'models', 'streaming-output']
      : [],
  }));
}
