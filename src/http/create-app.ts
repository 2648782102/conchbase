import Fastify from 'fastify';
import type { TaskService } from '../runtime/task-service.js';
import { registerConfigurationRoutes } from './routes/v1/configuration.js';
import { registerEventRoutes } from './routes/v1/events.js';
import { registerHealthRoute } from './routes/v1/health.js';
import { registerModelRoutes } from './routes/v1/models.js';
import { registerProviderObservationRoutes } from './routes/v1/provider-observations.js';
import { registerRuntimeRoute } from './routes/v1/runtime.js';
import { registerTaskRoutes } from './routes/v1/tasks.js';
import { registerToolRequestRoutes } from './routes/v1/tool-requests.js';
import { registerAgentRoutes } from './routes/v1/agents.js';
import { registerWorkRoutes } from './routes/v1/work.js';

export function createApp(options: {
  logger?: boolean;
  taskService?: TaskService;
} = {}) {
  const app = Fastify({ logger: options.logger ?? true });
  const workStore = options.taskService?.store?.work;

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

  return app;
}
