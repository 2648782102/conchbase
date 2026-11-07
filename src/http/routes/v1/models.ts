import type { FastifyInstance } from 'fastify';
import type { TaskService } from '../../../runtime/task-service.js';

export function registerModelRoutes(
  app: FastifyInstance,
  taskService: TaskService | undefined,
): void {
  app.get('/v1/models', async (_request, reply) => {
    if (!taskService) {
      return reply.code(503).send({ error: 'Task service is not configured.' });
    }
    try {
      return { models: await taskService.listModels() };
    } catch {
      return reply.code(502).send({ error: 'Model catalog is unavailable.' });
    }
  });
}
