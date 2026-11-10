import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { rawSha256Digest } from '../runtime/platform-contract.js';
import type { PlatformStore } from '../runtime/platform-store.js';

export interface AuthOptions {
  readonly loopback: boolean;
  readonly tokenDigest?: string;
  readonly platform?: PlatformStore;
}

function equalDigest(left: string, right: string): boolean {
  const leftHash = createHash('sha256').update(left).digest();
  const rightHash = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

export function installAuthHook(
  app: { addHook(name: 'onRequest', hook: (request: FastifyRequest, reply: FastifyReply) => Promise<void> | void): void },
  options: AuthOptions,
): void {
  app.addHook('onRequest', async (request, reply) => {
    if (options.loopback) return;
    const header = request.headers.authorization;
    const token = typeof header === 'string' && header.startsWith('Bearer ')
      ? header.slice('Bearer '.length)
      : '';
    const digest = rawSha256Digest(token);
    const configured = options.tokenDigest !== undefined && equalDigest(digest, options.tokenDigest);
    const paired = options.platform?.isTokenActive(token) ?? false;
    if (!configured && !paired) {
      await reply.code(401).send({ error: 'Authenticated binding requires an approved token.' });
    }
  });
}
