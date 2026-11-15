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
  loopBudget?: LoopBudget,
): void {
  app.get('/v1/runtime', async () => ({
    name: 'Conchbase',
    version: '1.0.0',
    state: 'ready',
    executionMode,
    ...(loopBudget ? { loopBudget } : {}),
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
