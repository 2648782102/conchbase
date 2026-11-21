import type { FastifyInstance } from 'fastify';
import type { ExecutionMode, LoopBudget } from '../../../config/runtime-config.js';
import type { PermissionLevel } from '../../../kernel/policy.js';
import {
  AGENT_CHAT_PUBLIC_PATHS,
  AGENT_CHAT_CONTRACT_VERSION,
} from '../../../runtime/agent-chat.js';
import {
  EXECUTION_PUBLIC_PATHS,
  EXECUTION_CONTRACT_VERSION,
} from '../../../runtime/controlled-execution.js';
import {
  EXECUTION_RUN_PUBLIC_PATHS,
  EXECUTION_RUN_CONTRACT_VERSION,
} from '../../../runtime/isolated-execution.js';
import {
  ORGANIZATION_PUBLIC_PATHS,
  ORGANIZATION_PUBLIC_CONTRACT_VERSION,
} from '../../../runtime/organization-public-contract.js';
import {
  PRIMARY_CONVERSATION_PUBLIC_PATHS,
  PRIMARY_CONVERSATION_CONTRACT_VERSION,
} from '../../../runtime/primary-conversation.js';
import {
  MEMORY_PUBLIC_PATHS,
  MEMORY_PUBLIC_CONTRACT_VERSION,
} from './memory.js';

export function registerRuntimeRoute(
  app: FastifyInstance,
  tasksEnabled = false,
  organizationEnabled = false,
  executionEnabled = false,
  executionRunEnabled = false,
  conversationEnabled = false,
  agentChatEnabled = false,
  executionMode: ExecutionMode = 'restricted',
  permissionLevel?: PermissionLevel,
  loopBudget?: LoopBudget,
  projectIdleMs?: number,
  memoryEnabled = false,
  scheduler?: { readonly globalActiveWork: number; readonly perProjectActiveWork: number },
): void {
  app.get('/v1/runtime', async () => ({
    name: 'Conchbase',
    version: '1.0.0',
    state: 'ready',
    executionMode,
    ...(permissionLevel ? { permissionLevel } : {}),
    ...(loopBudget ? { loopBudget } : {}),
    ...(projectIdleMs === undefined ? {} : {
      projectConvergence: {
        idleAfterMs: projectIdleMs,
      },
    }),
    ...(organizationEnabled ? {
      organizationContract: ORGANIZATION_PUBLIC_CONTRACT_VERSION,
      organizationPaths: ORGANIZATION_PUBLIC_PATHS.length,
    } : {}),
    ...(executionEnabled ? {
      executionContract: EXECUTION_CONTRACT_VERSION,
      executionPaths: EXECUTION_PUBLIC_PATHS.length,
    } : {}),
    ...(executionRunEnabled ? {
      executionRunContract: EXECUTION_RUN_CONTRACT_VERSION,
      executionRunPaths: EXECUTION_RUN_PUBLIC_PATHS.length,
    } : {}),
    ...(conversationEnabled ? {
      conversationContract: PRIMARY_CONVERSATION_CONTRACT_VERSION,
      conversationPaths: PRIMARY_CONVERSATION_PUBLIC_PATHS.length,
    } : {}),
    ...(agentChatEnabled ? {
      agentChatContract: AGENT_CHAT_CONTRACT_VERSION,
      agentChatPaths: AGENT_CHAT_PUBLIC_PATHS.length,
    } : {}),
    ...(memoryEnabled ? {
      memoryContract: MEMORY_PUBLIC_CONTRACT_VERSION,
      memoryPaths: MEMORY_PUBLIC_PATHS.length,
    } : {}),
    ...(scheduler ? {
      globalWorkScheduler: {
        version: 1,
        globalActiveWork: scheduler.globalActiveWork,
        perProjectActiveWork: scheduler.perProjectActiveWork,
      },
    } : {}),
    capabilities: tasksEnabled
      ? [
        'tasks',
        'events',
        'models',
        'streaming-output',
        'configuration-revisions',
        'composition-execution',
        'tool-approval-ledger',
        'provider-tool-call-observation',
        'agents',
        'provider-neutral-model-catalog',
        'durable-work-contract',
        'authenticated-pairing',
        'asynchronous-work-control',
        'local-source-policy',
        'capability-directory',
        'write-only-secret-handles',
        'execution-modes',
      ]
      : [],
  }));
}
