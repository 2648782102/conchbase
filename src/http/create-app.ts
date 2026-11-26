import Fastify, { LogController } from 'fastify';
import type { RuntimeConfig } from '../config/runtime-config.js';
import type { TaskService } from '../runtime/task-service.js';
import type { OrganizationStore } from '../runtime/organization-store.js';
import { BossModeService } from '../runtime/boss-mode-service.js';
import { ControlledExecutionService } from '../runtime/controlled-execution.js';
import { IsolatedExecutionService } from '../runtime/isolated-execution.js';
import { PrimaryConversationService } from '../runtime/primary-conversation.js';
import { AgentChatService } from '../runtime/agent-chat.js';
import type { CapabilityGrant } from '../runtime/agent-profile.js';
import { installAuthHook } from './auth.js';
import { registerConfigurationRoutes } from './routes/v1/configuration.js';
import { registerAgentChatRoutes } from './routes/v1/agent-chat.js';
import { registerMemoryRoutes } from './routes/v1/memory.js';
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
import { registerOperationsRoutes } from './routes/v1/operations.js';
import { registerTaskRoutes } from './routes/v1/tasks.js';
import { registerToolRequestRoutes } from './routes/v1/tool-requests.js';
import { registerAgentRoutes } from './routes/v1/agents.js';
import { registerWorkRoutes } from './routes/v1/work.js';
import { registerScheduleRoutes } from './routes/v1/schedules.js';
import { registerWorkspaceRoutes } from './routes/v1/workspace.js';

export interface CreateAppOptions {
  logger?: boolean;
  taskService?: TaskService;
  organizationStore?: OrganizationStore;
  bossModeService?: BossModeService;
  executionService?: ControlledExecutionService;
  executionRunService?: IsolatedExecutionService;
  conversationService?: PrimaryConversationService;
  agentChatService?: AgentChatService;
  workerCapabilityGrants?: () => readonly CapabilityGrant[];
  config?: RuntimeConfig;
}

export function createApp(options: CreateAppOptions = {}) {
  // Never serialize request bodies into logs: they can contain prompts and
  // tool arguments. The error hook below logs a category and identifiers only.
  //
  // `logController` is how Fastify 5 disables request/response logging; the
  // top-level `disableRequestLogging` option is deprecated and prints a warning
  // on every start.
  const app = Fastify({
    logger: options.logger ?? true,
    logController: new LogController({ disableRequestLogging: true }),
  });
  app.addHook('onError', async (request, _reply, error) => {
    const { toErrorRecord, formatErrorLog } = await import('../runtime/error-categories.js');
    const record = toErrorRecord(error, { requestId: request.id });
    request.log?.warn?.(formatErrorLog(record));
  });
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
        ? {
          workerCapabilityGrants: options.workerCapabilityGrants ?? (() => Object.freeze([])),
          settleBeforeWorkers: true,
          ...(options.config ? {
            schedulerLimits: {
              globalActive: options.config.globalActiveWork,
              perProjectActive: options.config.perProjectActiveWork,
            },
            workerSliceIterations: options.config.workerSliceIterations,
            sequentialWorkers: true,
          } : {}),
          conversation: {
            recordIntentText: (intentId, text) => conversation.recordIntentText(intentId, text),
            intentTexts: () => conversation.intentTextsView(),
          },
        }
        : {
          workerCapabilityGrants: options.workerCapabilityGrants ?? (() => Object.freeze([])),
          settleBeforeWorkers: true,
          ...(options.config ? {
            schedulerLimits: {
              globalActive: options.config.globalActiveWork,
              perProjectActive: options.config.perProjectActiveWork,
            },
            workerSliceIterations: options.config.workerSliceIterations,
            sequentialWorkers: true,
          } : {}),
        })
      : undefined);
  const agentChat = options.agentChatService
    ?? (options.taskService ? new AgentChatService(options.taskService, bossMode) : undefined);
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
    Boolean(agentChat),
    options.config?.executionMode ?? 'restricted',
    options.config?.permissionLevel,
    options.config?.loopBudget,
    options.config?.projectIdleMs,
    Boolean(options.taskService?.store?.memory),
    Boolean(options.taskService?.store?.schedules),
    options.config
      ? {
        globalActiveWork: options.config.globalActiveWork,
        perProjectActiveWork: options.config.perProjectActiveWork,
      }
      : undefined,
    Boolean(options.config?.workspaceRoot),
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
  registerAgentChatRoutes(app, agentChat);
  registerMemoryRoutes(app, options.taskService?.store?.memory);
  registerOperationsRoutes(app, options.taskService, options.config);
  registerExecutionRoutes(app, execution);
  registerExecutionRunRoutes(app, executionRuns);
  registerScheduleRoutes(app, options.taskService);
  /*
   * The `@` picker's index. Kept behind the configured workspace root: a
   * Runtime that has no workspace has nothing to offer, and the route is
   * absent rather than answering with an empty list that looks like "no
   * files exist".
   */
  registerWorkspaceRoutes(app, options.config?.workspaceRoot);

  // Service discovery for a human or agent arriving at the Runtime without
  // prior knowledge of the route surface. This is a non-versioned convenience
  // index; the versioned /v1/* contract remains the source of truth.
  app.get('/', async () => ({
    service: 'conchbase',
    status: 'ok',
    apiVersion: 1,
    capabilities: {
      agentChat: Boolean(agentChat),
      organization: Boolean(organization),
      taskExecution: Boolean(options.taskService),
      models: Boolean(options.taskService),
    },
    entryPoints: {
      health: '/v1/health',
      models: '/v1/models',
      agents: '/v1/agent-chat/agents',
      // Stateful multi-turn conversation is the primary user entry point.
      conversations: '/v1/agent-chat/conversations',
      singleShotTasks: '/v1/tasks',
      openapi: 'docs/openapi.yaml in the repository checkout',
    },
    hint: 'For a multi-turn assistant, POST /v1/agent-chat/conversations, then POST /v1/agent-chat/conversations/{id}/messages with {text, idempotencyKey}.',
  }));

  return app;
}
