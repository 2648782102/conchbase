import Fastify from 'fastify';
import type { RuntimeConfig } from '../config/runtime-config.js';
import type { TaskService } from '../runtime/task-service.js';
import { installAuthHook } from './auth.js';
import { registerConfigurationRoutes } from './routes/v1/configuration.js';
import { registerEventRoutes } from './routes/v1/events.js';
import { registerHealthRoute } from './routes/v1/health.js';
import { registerModelRoutes } from './routes/v1/models.js';
import { registerPlatformRoutes } from './routes/v1/platform.js';
import { registerProviderObservationRoutes } from './routes/v1/provider-observations.js';
import { registerRuntimeRoute } from './routes/v1/runtime.js';
import { registerTaskRoutes } from './routes/v1/tasks.js';
import { registerToolRequestRoutes } from './routes/v1/tool-requests.js';
import { registerAgentRoutes } from './routes/v1/agents.js';
import { registerWorkRoutes } from './routes/v1/work.js';

export interface CreateAppOptions {
  logger?: boolean;
  taskService?: TaskService;
  config?: RuntimeConfig;
}

export function createApp(options: CreateAppOptions = {}) {
  const app = Fastify({ logger: options.logger ?? true });
  const workStore = options.taskService?.store?.work;
  const platform = options.taskService?.store?.platform;
  const loopback = options.config?.host === undefined
    || ['127.0.0.1', '::1', 'localhost'].includes(options.config.host);

  installAuthHook(app, {
    loopback,
    ...(options.config?.authTokenDigest ? { tokenDigest: options.config.authTokenDigest } : {}),
    ...(platform ? { platform } : {}),
  });

  registerHealthRoute(app);
  registerAgentRoutes(app, options.taskService);
  registerRuntimeRoute(app, Boolean(options.taskService));
  registerConfigurationRoutes(app, options.taskService);
  registerEventRoutes(app, options.taskService);
  registerModelRoutes(app, options.taskService);
  registerProviderObservationRoutes(app);
  registerTaskRoutes(app, options.taskService);
  registerToolRequestRoutes(app, options.taskService);
  registerWorkRoutes(app, workStore);
  registerPlatformRoutes(app, platform);

  return app;
}
