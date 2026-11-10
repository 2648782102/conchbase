import type { FastifyInstance } from 'fastify';
import {
  WorkConflictError,
  WorkNotFoundError,
  WorkValidationError,
  WORK_CONTRACT_VERSION,
  parseWorkTriggerRequest,
} from '../../../runtime/work-contract.js';
import type { WorkStore } from '../../../runtime/work-store.js';

function unavailable(reply: {
  code(status: number): { send(payload: unknown): unknown };
}) {
  return reply.code(503).send({ error: 'Work store is not configured.' });
}

export function registerWorkRoutes(app: FastifyInstance, workStore: WorkStore | undefined): void {
  void app.register(async (scope) => {
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
      done(null, body);
    });
    scope.setErrorHandler((cause, _request, reply) => {
      if ((cause as { validation?: unknown }).validation) {
        void reply.code(400).send({ error: 'Work Trigger does not match the versioned contract.' });
        return;
      }
      void reply.code(500).send({ error: 'Internal runtime error.' });
    });

    scope.post('/v1/work/triggers', async (request, reply) => {
      if (!workStore) return unavailable(reply);
      try {
        const parsed = parseWorkTriggerRequest(JSON.parse(request.body as string));
        const envelope = workStore.ingestWorkTrigger(parsed);
        reply.code(envelope.created ? 201 : 200);
        return envelope;
      } catch (cause) {
        if (cause instanceof SyntaxError) {
          return reply.code(400).send({ error: 'Work Trigger must be a JSON object.' });
        }
        if (cause instanceof WorkValidationError) {
          return reply.code(400).send({ error: cause.message });
        }
        if (cause instanceof WorkConflictError) {
          return reply.code(409).send({ error: cause.message });
        }
        throw cause;
      }
    });

    scope.get('/v1/work/items', async (_request, reply) => {
      if (!workStore) return unavailable(reply);
      return { version: WORK_CONTRACT_VERSION, workItems: workStore.listWorkItems() };
    });

    scope.get<{ Params: { workItemId: string } }>(
      '/v1/work/items/:workItemId',
      async (request, reply) => {
        if (!workStore) return unavailable(reply);
        try {
          return workStore.getWorkItemDetail(request.params.workItemId);
        } catch (cause) {
          if (cause instanceof WorkNotFoundError) {
            return reply.code(404).send({ error: cause.message });
          }
          throw cause;
        }
      },
    );

    scope.get('/v1/work/delivery-receipts', async (_request, reply) => {
      if (!workStore) return unavailable(reply);
      return { version: WORK_CONTRACT_VERSION, deliveryReceipts: workStore.listDeliveryReceipts() };
    });
  });
}

