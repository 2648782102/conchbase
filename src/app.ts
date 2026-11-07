import Fastify from 'fastify';

export function buildApp() {
  const app = Fastify({ logger: true });

  app.get('/v1/health', async () => ({
    status: 'ok',
    service: 'conchbase',
    apiVersion: 1,
  }));

  app.get('/v1/runtime', async () => ({
    name: 'Conchbase',
    version: '0.1.0',
    state: 'ready',
    capabilities: [],
  }));

  return app;
}
