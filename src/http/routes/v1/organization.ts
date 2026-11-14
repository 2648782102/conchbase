import type { FastifyInstance } from 'fastify';
import {
  OrganizationNotFoundError,
  type OrganizationEvent,
  type OrganizationSnapshot,
} from '../../../runtime/organization-contract.js';
import {
  isOrganizationValidationError,
  organizationEventCursor,
  organizationEventLimit,
  organizationAttentionVersion,
  organizationIntentFingerprint,
  organizationIntentId,
  organizationIntentResult,
  parseAttentionSubmission,
  parseOrganizationActionSubmission,
  parseOrganizationIntentSubmission,
  requireOrganizationStore,
} from '../../../runtime/organization-contract-http.js';
import { ORGANIZATION_PUBLIC_CONTRACT_VERSION } from '../../../runtime/organization-public-contract.js';
import type { OrganizationStore } from '../../../runtime/organization-store.js';
import type { BossModeService } from '../../../runtime/boss-mode-service.js';

function unavailable(reply: { code(status: number): { send(payload: unknown): unknown } }) {
  return reply.code(503).send({ error: 'Organization Runtime is not configured.' });
}

function eventResponse(event: OrganizationEvent) {
  return Object.freeze({
    id: event.id,
    sequence: event.sequence,
    type: event.type,
    projectId: event.projectId,
    data: event.data,
    expectedVersion: event.sequence,
  });
}

function attentionView(request: OrganizationSnapshot['attentionRequests'][number]) {
  return Object.freeze({
    ...request,
    expectedVersion: organizationAttentionVersion(request),
  });
}

function publishedSession(snapshot: OrganizationSnapshot) {
  return {
    version: ORGANIZATION_PUBLIC_CONTRACT_VERSION,
    bossSession: snapshot.bossSession,
    projects: snapshot.projects,
    delegations: snapshot.delegations,
    workers: snapshot.workers,
    reports: snapshot.reports,
    attentionRequests: snapshot.attentionRequests.map(attentionView),
  };
}

function decisionAction(
  snapshot: OrganizationSnapshot,
  attentionId: string,
  kind: 'answer' | 'withdraw',
  decisionDigest: string,
) {
  const request = snapshot.attentionRequests.find((candidate) => candidate.id === attentionId);
  if (!request) throw new OrganizationNotFoundError('AttentionRequest not found.');
  return {
    type: kind === 'answer' ? 'answer_attention' : 'withdraw_attention',
    expectedSequence: snapshot.events.length,
    projectId: request.projectId,
    attentionId,
    decisionDigest,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorStatus(cause: unknown): number {
  if (cause instanceof OrganizationNotFoundError) return 404;
  if (cause instanceof Error && cause.name === 'OrganizationConflictError') return 409;
  return 400;
}

function errorResponse(reply: { code(status: number): { send(payload: unknown): unknown } }, cause: unknown) {
  const message = cause instanceof Error ? cause.message : 'Organization request was rejected.';
  return reply.code(errorStatus(cause)).send({
    error: message.slice(0, 240).replace(/[\u0000-\u001f\u007f]/g, ' '),
  });
}

export function registerOrganizationRoutes(
  app: FastifyInstance,
  organizationStore: OrganizationStore | undefined,
  bossMode?: BossModeService,
): void {
  void app.register(async (scope) => {
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
      done(null, body);
    });

    scope.get('/v1/organization/session', async (_request, reply) => {
      if (!organizationStore) return unavailable(reply);
      return reply.send(publishedSession(organizationStore.get()));
    });

    const intentResults = new Map<string, {
      readonly result: ReturnType<typeof organizationIntentResult>;
      readonly fingerprint: string;
    }>();
    scope.post('/v1/organization/session/intents', async (request, reply) => {
      if (!organizationStore) return unavailable(reply);
      try {
        const input = typeof request.body === 'string' ? JSON.parse(request.body) : request.body;
        if (bossMode && isRecord(input) && isRecord(input.intent) && 'text' in input.intent) {
          const submitted = await bossMode.submit({
            text: input.intent.text,
            idempotencyKey: input.intent.idempotencyKey,
          });
          return reply.code(202).send({
            version: ORGANIZATION_PUBLIC_CONTRACT_VERSION,
            intentId: submitted.intentId,
            state: 'accepted',
            expectedSequence: submitted.expectedSequence,
          });
        }
        const parsed = parseOrganizationActionSubmission(input);
        const submission = isRecord(input) && isRecord(input.intent)
          ? parseOrganizationIntentSubmission(input.intent)
          : undefined;
        if (submission) {
          const fingerprint = organizationIntentFingerprint(submission);
          const replayed = intentResults.get(submission.idempotencyKey);
          if (replayed) {
            if (replayed.fingerprint !== fingerprint) {
              return reply.code(409).send({ error: 'Organization intent idempotency key conflicts with its original body.' });
            }
            return reply.code(202).send(replayed.result);
          }
          const next = organizationStore.apply(parsed);
          const result = organizationIntentResult(
            organizationIntentId(submission.idempotencyKey),
            next.events.length,
          );
          intentResults.set(submission.idempotencyKey, { result, fingerprint });
          return reply.code(202).send(result);
        }
        const next = organizationStore.apply(parsed);
        return reply.code(202).send(organizationIntentResult(
          `int_${String(next.events.length).padStart(12, '0')}`,
          next.events.length,
        ));
      } catch (cause) {
        if (cause instanceof Error && (cause.name === 'BossModeServiceError' || cause.name === 'OrganizationIntentParseError')) {
          return reply.code(cause.name === 'BossModeServiceError' ? 503 : 400).send({ error: cause.message.slice(0, 240) });
        }
        if (cause instanceof Error && cause.name === 'OrganizationConflictError') {
          return reply.code(409).send({ error: cause.message.slice(0, 240) });
        }
        if (isOrganizationValidationError(cause)) {
          return errorResponse(reply, cause);
        }
        throw cause;
      }
    });

    scope.get('/v1/organization/projects', async (_request, reply) => {
      if (!organizationStore) return unavailable(reply);
      const snapshot = organizationStore.get();
      return {
        version: ORGANIZATION_PUBLIC_CONTRACT_VERSION,
        projects: snapshot.projects,
      };
    });

    scope.get<{ Params: { projectId: string } }>('/v1/organization/projects/:projectId', async (request, reply) => {
      if (!organizationStore) return unavailable(reply);
      const project = organizationStore.get().projects.find((item) => item.id === request.params.projectId);
      if (!project) return reply.code(404).send({ error: 'Organization project not found.' });
      return { version: ORGANIZATION_PUBLIC_CONTRACT_VERSION, project };
    });

    scope.get<{ Params: { projectId: string } }>(
      '/v1/organization/projects/:projectId/threads',
      async (request, reply) => {
        if (!organizationStore) return unavailable(reply);
        const snapshot = organizationStore.get();
        if (!snapshot.projects.some((project) => project.id === request.params.projectId)) {
          return reply.code(404).send({ error: 'Organization project not found.' });
        }
        const projectEvents = snapshot.events.filter((event) => event.projectId === request.params.projectId);
        return {
          version: ORGANIZATION_PUBLIC_CONTRACT_VERSION,
          projectId: request.params.projectId,
          threads: Object.freeze(projectEvents.map((event) => Object.freeze({
            eventId: event.id,
            sequence: event.sequence,
            type: event.type,
          }))),
        };
      },
    );

    scope.get('/v1/organization/agents/proposals', async (_request, reply) => {
      if (!organizationStore) return unavailable(reply);
      return {
        version: ORGANIZATION_PUBLIC_CONTRACT_VERSION,
        proposals: organizationStore.get().workers.map((worker) => Object.freeze({
          workerId: worker.id,
          projectId: worker.projectId,
          agentRevisionId: worker.agentRevisionId,
          instructionsDigest: worker.instructionsDigest,
          state: worker.state,
        })),
      };
    });

    scope.get<{ Params: { proposalId: string } }>(
      '/v1/organization/agents/proposals/:proposalId',
      async (request, reply) => {
        if (!organizationStore) return unavailable(reply);
        const worker = organizationStore.get().workers.find((item) => item.id === request.params.proposalId);
        if (!worker) return reply.code(404).send({ error: 'Organization agent proposal not found.' });
        return { version: ORGANIZATION_PUBLIC_CONTRACT_VERSION, proposal: worker };
      },
    );

    scope.get('/v1/organization/delegations', async (_request, reply) => {
      if (!organizationStore) return unavailable(reply);
      return {
        version: ORGANIZATION_PUBLIC_CONTRACT_VERSION,
        delegations: organizationStore.get().delegations,
      };
    });

    scope.get<{ Params: { delegationId: string } }>(
      '/v1/organization/delegations/:delegationId',
      async (request, reply) => {
        if (!organizationStore) return unavailable(reply);
        const delegation = organizationStore.get().delegations
          .find((item) => item.id === request.params.delegationId);
        if (!delegation) return reply.code(404).send({ error: 'Organization delegation not found.' });
        return { version: ORGANIZATION_PUBLIC_CONTRACT_VERSION, delegation };
      },
    );

    scope.get('/v1/organization/work-items', async (_request, reply) => {
      if (!organizationStore) return unavailable(reply);
      const snapshot = organizationStore.get();
      return {
        version: ORGANIZATION_PUBLIC_CONTRACT_VERSION,
        workItems: Object.freeze(snapshot.workers.map((worker) => Object.freeze({
          workItemId: `work_${worker.id}`,
          projectId: worker.projectId,
          workerId: worker.id,
          state: worker.state,
        }))),
      };
    });

    scope.get<{ Params: { workItemId: string } }>(
      '/v1/organization/work-items/:workItemId',
      async (request, reply) => {
        if (!organizationStore) return unavailable(reply);
        const workerId = request.params.workItemId.startsWith('work_')
          ? request.params.workItemId.slice(5)
          : request.params.workItemId;
        const worker = organizationStore.get().workers.find((item) => item.id === workerId);
        if (!worker) return reply.code(404).send({ error: 'Organization work item not found.' });
        return {
          version: ORGANIZATION_PUBLIC_CONTRACT_VERSION,
          workItem: Object.freeze({
            workItemId: request.params.workItemId,
            projectId: worker.projectId,
            workerId: worker.id,
            state: worker.state,
          }),
        };
      },
    );

    scope.get('/v1/organization/reports', async (_request, reply) => {
      if (!organizationStore) return unavailable(reply);
      return {
        version: ORGANIZATION_PUBLIC_CONTRACT_VERSION,
        reports: organizationStore.get().reports,
      };
    });

    scope.get<{ Params: { reportId: string } }>(
      '/v1/organization/reports/:reportId',
      async (request, reply) => {
        if (!organizationStore) return unavailable(reply);
        const report = organizationStore.get().reports.find((item) => item.id === request.params.reportId);
        if (!report) return reply.code(404).send({ error: 'Organization report not found.' });
        return { version: ORGANIZATION_PUBLIC_CONTRACT_VERSION, report };
      },
    );

    scope.get('/v1/organization/attention', async (_request, reply) => {
      if (!organizationStore) return unavailable(reply);
      return {
        version: ORGANIZATION_PUBLIC_CONTRACT_VERSION,
          attentionRequests: organizationStore.get().attentionRequests.map(attentionView),
      };
    });

    scope.get<{ Params: { attentionId: string } }>(
      '/v1/organization/attention/:attentionId',
      async (request, reply) => {
        if (!organizationStore) return unavailable(reply);
        const requestRecord = organizationStore.get().attentionRequests
          .find((item) => item.id === request.params.attentionId);
        if (!requestRecord) return reply.code(404).send({ error: 'Organization attention request not found.' });
        return {
          version: ORGANIZATION_PUBLIC_CONTRACT_VERSION,
          attentionRequest: attentionView(requestRecord),
        };
      },
    );

    for (const kind of ['answer', 'withdraw'] as const) {
      scope.post<{ Params: { attentionId: string } }>(
        `/v1/organization/attention/:attentionId/${kind}`,
        async (request, reply) => {
          if (!organizationStore) return unavailable(reply);
          try {
            const body = typeof request.body === 'string' ? JSON.parse(request.body) : request.body;
            const submission = parseAttentionSubmission(body);
            const snapshot = organizationStore.get();
            const current = snapshot.attentionRequests
              .find((item) => item.id === request.params.attentionId);
            if (!current) throw new OrganizationNotFoundError('Organization attention request not found.');
            if (current.state !== 'open') {
              return reply.code(409).send({ error: 'AttentionRequest is not open.' });
            }
            if (submission.expectedVersion !== organizationAttentionVersion(current)) {
              return reply.code(409).send({ error: 'AttentionRequest expectedVersion is stale.' });
            }
            const action = decisionAction(
              snapshot,
              request.params.attentionId,
              kind,
              submission.decisionDigest ?? `sha256:${'0'.repeat(64)}`,
            );
            if (bossMode) {
              bossMode.decideAttention(
                request.params.attentionId,
                kind,
                submission.expectedVersion,
                submission.decisionDigest,
              );
              const next = organizationStore.get();
              return {
                version: ORGANIZATION_PUBLIC_CONTRACT_VERSION,
                attentionRequest: attentionView(
                  next.attentionRequests.find((item) => item.id === request.params.attentionId)!,
                ),
              };
            }
            const next = organizationStore.apply(action);
            return {
              version: ORGANIZATION_PUBLIC_CONTRACT_VERSION,
              attentionRequest: attentionView(
                next.attentionRequests.find((item) => item.id === request.params.attentionId)!,
              ),
            };
          } catch (cause) {
            if (isOrganizationValidationError(cause)) {
              return errorResponse(reply, cause);
            }
            throw cause;
          }
        },
      );
    }

    scope.get<{ Querystring: { after?: string; limit?: string } }>(
      '/v1/organization/events',
      async (request, reply) => {
        if (!organizationStore) return unavailable(reply);
        try {
          const after = organizationEventCursor(request.query.after);
          const limit = organizationEventLimit(request.query.limit);
          const events = organizationStore.events(1000);
          const cursorIndex = after === undefined ? -1 : events.findIndex((event) => event.id === after);
          if (after !== undefined && cursorIndex < 0) {
            return reply.code(400).send({ error: 'Unknown organization event cursor.' });
          }
          const start = cursorIndex + 1;
          const page = events.slice(start, start + limit);
          const hasMore = start + page.length < events.length;
          return {
            version: ORGANIZATION_PUBLIC_CONTRACT_VERSION,
            events: page.map(eventResponse),
            nextCursor: page.length > 0 ? page[page.length - 1]!.id : null,
            hasMore,
          };
        } catch (cause) {
          if (isOrganizationValidationError(cause)) {
            return errorResponse(reply, cause);
          }
          throw cause;
        }
      },
    );
  });
}

export { requireOrganizationStore };
