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
import {
  SCHEDULE_PUBLIC_PATHS,
  SCHEDULE_CONTRACT_VERSION,
} from './schedules.js';

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
  schedulesEnabled = false,
  scheduler?: { readonly globalActiveWork: number; readonly perProjectActiveWork: number },
): void {
  /*
   * `permissionLevel` is the decision; `executionMode` is only how it was
   * configured.
   *
   * Both used to be published as if they were independent. They are not:
   * `CONCHBASE_PERMISSION_LEVEL=strict` with the default
   * `CONCHBASE_EXECUTION_MODE=restricted` published `executionMode:
   * "restricted"`, which reads like "approval is on" while every action was
   * actually being denied. A client cannot be asked to reconcile two fields it
   * was never told the precedence of, so the effective level is what gets
   * published; the mode is labelled as provenance.
   */
  const level: PermissionLevel = permissionLevel ?? (executionMode === 'unrestricted' ? 'trusted' : 'standard');
  app.get('/v1/runtime', async () => ({
    name: 'Conchbase',
    version: '1.0.0',
    state: 'ready',
    permissionLevel: level,
    executionMode,
    executionModeIsLegacy: true,
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
    ...(schedulesEnabled ? {
      scheduleContract: SCHEDULE_CONTRACT_VERSION,
      schedulePaths: SCHEDULE_PUBLIC_PATHS.length,
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
