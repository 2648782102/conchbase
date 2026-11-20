import type { FastifyInstance } from 'fastify';
import type { ExecutionMode, LoopBudget } from '../../../config/runtime-config.js';

export function registerRuntimeRoute(
  app: FastifyInstance,
  tasksEnabled = false,
  organizationEnabled = false,
  executionEnabled = false,
  executionRunEnabled = false,
  conversationEnabled = false,
  agentChatEnabled = false,
  executionMode: ExecutionMode = 'restricted',
  permissionLevel?: 'standard' | 'trusted',
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
      organizationContract: '1.1.0' as const,
      organizationPaths: 18,
    } : {}),
    ...(executionEnabled ? {
      executionContract: '1.2.0' as const,
      executionPaths: 8,
    } : {}),
    ...(executionRunEnabled ? {
      executionRunContract: '1.3.0' as const,
      executionRunPaths: 8,
    } : {}),
    ...(conversationEnabled ? {
      conversationContract: '1.4.0' as const,
      conversationPaths: 2,
    } : {}),
    ...(agentChatEnabled ? {
      agentChatContract: '1.8.0' as const,
      agentChatPaths: 6,
    } : {}),
    ...(memoryEnabled ? {
      memoryContract: '1.9.0' as const,
      memoryPaths: 2,
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
