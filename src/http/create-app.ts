import Fastify from 'fastify';
import type { RuntimeConfig } from '../config/runtime-config.js';
import type { TaskService } from '../runtime/task-service.js';
import type { OrganizationStore } from '../runtime/organization-store.js';
import { BossModeService } from '../runtime/boss-mode-service.js';
import { ControlledExecutionService } from '../runtime/controlled-execution.js';
import { IsolatedExecutionService } from '../runtime/isolated-execution.js';
import { PrimaryConversationService } from '../runtime/primary-conversation.js';
import { installAuthHook } from './auth.js';
import { registerConfigurationRoutes } from './routes/v1/configuration.js';
import { registerConversationRoutes } from './routes/v1/conversation.js';
import { registerExecutionRoutes } from './routes/v1/execution.js';
import { registerExecutionRunRoutes } from './routes/v1/execution-runs.js';
import { registerEventRoutes } from './routes/v1/events.js';
import { registerHealthRoute } from './routes/v1/health.js';
import { registerModelRoutes } from './routes/v1/models.js';
import { registerOrganizationRoutes } from './routes/v1/organization.js';
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
  organizationStore?: OrganizationStore;
  bossModeService?: BossModeService;
  executionService?: ControlledExecutionService;
  executionRunService?: IsolatedExecutionService;
  conversationService?: PrimaryConversationService;
  config?: RuntimeConfig;
}

export function createApp(options: CreateAppOptions = {}) {
  const app = Fastify({ logger: options.logger ?? true });
  const workStore = options.taskService?.store?.work;
  const platform = options.taskService?.store?.platform;
  const organization = options.bossModeService?.organizationStore
    ?? options.organizationStore
    ?? options.taskService?.store?.organization;
  const conversation = options.conversationService
    ?? (organization ? new PrimaryConversationService() : undefined);
  const bossMode = options.bossModeService
    ?? (options.taskService && organization
      ? new BossModeService(organization, options.taskService, conversation
        ? { conversation: { recordIntentText: (intentId, text) => conversation.recordIntentText(intentId, text) } }
        : {})
      : undefined);
  const execution = options.executionService;
  const executionRuns = options.executionRunService;
  const loopback = options.config?.host === undefined
    || ['127.0.0.1', '::1', 'localhost'].includes(options.config.host);

  installAuthHook(app, {
    loopback,
    ...(options.config?.authTokenDigest ? { tokenDigest: options.config.authTokenDigest } : {}),
    ...(platform ? { platform } : {}),
  });

  registerHealthRoute(app);
  registerAgentRoutes(app, options.taskService);
  registerRuntimeRoute(
    app,
    Boolean(options.taskService),
    Boolean(organization),
    Boolean(execution),
    Boolean(executionRuns),
    Boolean(conversation),
  );
  registerConfigurationRoutes(app, options.taskService);
  registerEventRoutes(app, options.taskService);
  registerModelRoutes(app, options.taskService);
  registerProviderObservationRoutes(app);
  registerTaskRoutes(app, options.taskService);
  registerToolRequestRoutes(app, options.taskService);
  registerWorkRoutes(app, workStore);
  registerPlatformRoutes(app, platform);
  registerOrganizationRoutes(app, organization, bossMode);
  registerConversationRoutes(app, organization, conversation, options.taskService
    ? () => options.taskService!.store.listTasks().map((task) => ({
      taskId: task.id,
      state: task.state,
      attempt: task.attempt,
    }))
    : undefined);
  registerExecutionRoutes(app, execution);
  registerExecutionRunRoutes(app, executionRuns);

  return app;
}
