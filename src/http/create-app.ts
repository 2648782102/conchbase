import Fastify from 'fastify';
import { registerHealthRoute } from './routes/v1/health.js';
import { registerRuntimeRoute } from './routes/v1/runtime.js';

export function createApp(options: { logger?: boolean } = {}) {
  const app = Fastify({ logger: options.logger ?? true });

  registerHealthRoute(app);
  registerRuntimeRoute(app);

  return app;
}
