import type { FastifyInstance } from 'fastify';

export function registerRuntimeRoute(
  app: FastifyInstance,
  tasksEnabled = false,
  organizationEnabled = false,
  executionEnabled = false,
  executionRunEnabled = false,
  conversationEnabled = false,
): void {
  app.get('/v1/runtime', async () => ({
    name: 'Conchbase',
    version: '1.0.0',
    state: 'ready',
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
      ]
      : [],
  }));
}
