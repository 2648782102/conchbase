import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  PlatformConflictError,
  PlatformNotFoundError,
  PlatformValidationError,
  PLATFORM_CONTRACT_VERSION,
  parseCapabilityWrite,
  parsePairingApprove,
  parsePairingCreate,
  parseReceiptDecision,
  parseRecovery,
  parseSecretHandleCreate,
  parseSecretHandleRotate,
  parseSecretHandleStatus,
  parseSecretHandleUse,
  parseSourceEvent,
  parseTokenCreate,
  parseWorkControl,
  sha256Digest,
} from '../../../runtime/platform-contract.js';
import type { PlatformStore } from '../../../runtime/platform-store.js';

function unavailable(reply: FastifyReply): unknown {
  return reply.code(503).send({ error: 'Platform store is not configured.' });
}

function parseJson(body: unknown): unknown {
  if (typeof body === 'string') {
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new PlatformValidationError('Request body must be valid JSON.');
    }
  }
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) return body;
  throw new PlatformValidationError('Request body must be a JSON object.');
}

function validationError(reply: FastifyReply, cause: unknown): unknown {
  if (cause instanceof PlatformValidationError) {
    return reply.code(400).send({ error: cause.message });
  }
  if (cause instanceof PlatformNotFoundError) {
    return reply.code(404).send({ error: cause.message });
  }
  if (cause instanceof PlatformConflictError) {
    return reply.code(409).send({ error: cause.message });
  }
  throw cause;
}

async function withBody<T>(
  body: unknown,
  reply: FastifyReply,
  parse: (value: unknown) => T,
  action: (value: T) => unknown,
): Promise<unknown> {
  try {
    return await action(parse(parseJson(body)));
  } catch (cause) {
    return validationError(reply, cause);
  }
}

export function registerPlatformRoutes(app: FastifyInstance, platform: PlatformStore | undefined): void {
  app.get('/v1/auth/pairings', async (_request, reply) => {
    if (!platform) return unavailable(reply);
    return { version: PLATFORM_CONTRACT_VERSION, pairings: platform.listPairings() };
  });
  app.post('/v1/auth/pairings', async (request, reply) => withBody(
    request.body,
    reply,
    parsePairingCreate,
    ({ label }) => {
      if (!platform) return unavailable(reply);
      const createdAt = new Date().toISOString();
      const challengeDigest = sha256Digest({ label, createdAt });
      const pairing = platform.createPairing({ label, challengeDigest });
      reply.code(201);
      return { version: PLATFORM_CONTRACT_VERSION, pairing };
    },
  ));
  app.post('/v1/auth/pairings/approve', async (request, reply) => withBody(
    request.body,
    reply,
    parsePairingApprove,
    (input) => {
      if (!platform) return unavailable(reply);
      return { version: PLATFORM_CONTRACT_VERSION, pairing: platform.approvePairing(input) };
    },
  ));
  app.post<{ Params: { pairingId: string } }>(
    '/v1/auth/pairings/:pairingId/revoke',
    async (request, reply) => {
      if (!platform) return unavailable(reply);
      try {
        return { version: PLATFORM_CONTRACT_VERSION, pairing: platform.revokePairing(request.params.pairingId) };
      } catch (cause) {
        return validationError(reply, cause);
      }
    },
  );

  app.get('/v1/auth/tokens', async (_request, reply) => {
    if (!platform) return unavailable(reply);
    return { version: PLATFORM_CONTRACT_VERSION, tokens: platform.listTokens() };
  });
  app.post('/v1/auth/tokens', async (request, reply) => withBody(
    request.body,
    reply,
    parseTokenCreate,
    (input) => {
      if (!platform) return unavailable(reply);
      const token = platform.createToken(input);
      reply.code(201);
      return { version: PLATFORM_CONTRACT_VERSION, token };
    },
  ));
  app.post<{ Params: { tokenId: string } }>(
    '/v1/auth/tokens/:tokenId/revoke',
    async (request, reply) => {
      if (!platform) return unavailable(reply);
      try {
        return { version: PLATFORM_CONTRACT_VERSION, token: platform.revokeToken(request.params.tokenId) };
      } catch (cause) {
        return validationError(reply, cause);
      }
    },
  );

  app.get('/v1/sources/local/events', async (_request, reply) => {
    if (!platform) return unavailable(reply);
    return { version: PLATFORM_CONTRACT_VERSION, events: platform.listSourceEvents() };
  });
  app.post('/v1/sources/local/events', async (request, reply) => withBody(
    request.body,
    reply,
    parseSourceEvent,
    (event) => {
      if (!platform) return unavailable(reply);
      const stored = platform.ingestSourceEvent(event);
      reply.code(201);
      return { version: PLATFORM_CONTRACT_VERSION, event: stored };
    },
  ));

  app.get('/v1/capabilities', async (_request, reply) => {
    if (!platform) return unavailable(reply);
    return { version: PLATFORM_CONTRACT_VERSION, capabilities: platform.listCapabilities() };
  });
  app.post('/v1/capabilities', async (request, reply) => withBody(
    request.body,
    reply,
    parseCapabilityWrite,
    (input) => {
      if (!platform) return unavailable(reply);
      const capability = platform.putCapability(input);
      reply.code(201);
      return { version: PLATFORM_CONTRACT_VERSION, capability };
    },
  ));

  app.get('/v1/secret-handles', async (_request, reply) => {
    if (!platform) return unavailable(reply);
    return { version: PLATFORM_CONTRACT_VERSION, handles: platform.listSecretHandles() };
  });
  app.post('/v1/secret-handles', async (request, reply) => withBody(
    request.body,
    reply,
    parseSecretHandleCreate,
    (input) => {
      if (!platform) return unavailable(reply);
      const handle = platform.createSecretHandle(input);
      reply.code(201);
      return { version: PLATFORM_CONTRACT_VERSION, handle };
    },
  ));
  app.get('/v1/secret-handles/use-receipts', async (_request, reply) => {
    if (!platform) return unavailable(reply);
    return { version: PLATFORM_CONTRACT_VERSION, receipts: platform.listSecretHandleUseReceipts() };
  });
  app.post<{ Params: { handleId: string } }>(
    '/v1/secret-handles/:handleId/rotate',
    async (request, reply) => withBody(
      request.body,
      reply,
      parseSecretHandleRotate,
      ({ value }) => {
        if (!platform) return unavailable(reply);
        return { version: PLATFORM_CONTRACT_VERSION, handle: platform.rotateSecretHandle(request.params.handleId, value) };
      },
    ),
  );
  app.post<{ Params: { handleId: string } }>(
    '/v1/secret-handles/:handleId/status',
    async (request, reply) => withBody(
      request.body,
      reply,
      parseSecretHandleStatus,
      ({ status }) => {
        if (!platform) return unavailable(reply);
        return { version: PLATFORM_CONTRACT_VERSION, handle: platform.setSecretHandleStatus(request.params.handleId, status) };
      },
    ),
  );
  app.post<{ Params: { handleId: string } }>(
    '/v1/secret-handles/:handleId/use',
    async (request, reply) => withBody(
      request.body,
      reply,
      parseSecretHandleUse,
      (input) => {
        if (!platform) return unavailable(reply);
        if (input.handleId !== request.params.handleId) {
          return reply.code(409).send({ error: 'SecretHandle id does not match the route.' });
        }
        return { version: PLATFORM_CONTRACT_VERSION, receipt: platform.useSecretHandle(input) };
      },
    ),
  );

  app.get('/v1/work/events', async (_request, reply) => {
    if (!platform) return unavailable(reply);
    return { version: PLATFORM_CONTRACT_VERSION, events: platform.listWorkEvents() };
  });
  app.post<{ Params: { workItemId: string } }>(
    '/v1/work/items/:workItemId/start',
    async (request, reply) => withBody(
      request.body,
      reply,
      parseWorkControl,
      ({ expectedState }) => {
        if (!platform) return unavailable(reply);
        return { version: PLATFORM_CONTRACT_VERSION, workItem: platform.startWork(request.params.workItemId, expectedState) };
      },
    ),
  );
  app.post<{ Params: { workItemId: string } }>(
    '/v1/work/items/:workItemId/stop',
    async (request, reply) => withBody(
      request.body,
      reply,
      parseWorkControl,
      ({ expectedState }) => {
        if (!platform) return unavailable(reply);
        return { version: PLATFORM_CONTRACT_VERSION, workItem: platform.stopWork(request.params.workItemId, expectedState) };
      },
    ),
  );
  app.post<{ Params: { workItemId: string } }>(
    '/v1/work/items/:workItemId/complete',
    async (request, reply) => withBody(
      request.body,
      reply,
      parseWorkControl,
      ({ expectedState }) => {
        if (!platform) return unavailable(reply);
        return { version: PLATFORM_CONTRACT_VERSION, workItem: platform.completeWork(request.params.workItemId, expectedState) };
      },
    ),
  );
  app.post<{ Params: { assignmentId: string } }>(
    '/v1/work/assignments/:assignmentId/reconcile',
    async (request, reply) => withBody(
      request.body,
      reply,
      parseRecovery,
      ({ outcome }) => {
        if (!platform) return unavailable(reply);
        return {
          version: PLATFORM_CONTRACT_VERSION,
          workItem: platform.reconcileAssignment({ assignmentId: request.params.assignmentId, outcome }),
        };
      },
    ),
  );
  app.post<{ Params: { receiptId: string } }>(
    '/v1/work/delivery-receipts/:receiptId/decision',
    async (request, reply) => withBody(
      request.body,
      reply,
      parseReceiptDecision,
      ({ decision }) => {
        if (!platform) return unavailable(reply);
        return {
          version: PLATFORM_CONTRACT_VERSION,
          workItem: platform.decideDeliveryReceipt(request.params.receiptId, decision),
        };
      },
    ),
  );
}
