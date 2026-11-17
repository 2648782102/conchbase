import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { rawSha256Digest } from '../runtime/platform-contract.js';
import type { PlatformStore } from '../runtime/platform-store.js';

export interface AuthOptions {
  readonly loopback: boolean;
  readonly tokenDigest?: string;
  readonly platform?: PlatformStore;
}

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '0:0:0:0:0:0:0:1']);

/**
 * Reads the hostname out of a `Host` header, dropping the port.
 *
 * The security property is the name, not the port: a DNS-rebinding page keeps
 * sending its own domain in `Host`, so rejecting non-loopback names closes the
 * rebinding path regardless of which loopback port was bound.
 */
export function hostHeaderIsLoopback(header: string | undefined): boolean {
  if (typeof header !== 'string' || header.length === 0) return true;
  const hostname = header.startsWith('[')
    ? header.slice(1, header.indexOf(']'))
    : header.split(':')[0] ?? '';
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
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
    if (options.loopback) {
      // ADR 0025: a loopback bind is the entire trust boundary, so it has to be
      // proved. Without a Host check any page the user visits reaches this
      // Runtime after DNS rebinding — including tool results that carry
      // workspace file contents.
      if (!hostHeaderIsLoopback(request.headers.host)) {
        await reply.code(421).send({ error: 'Unexpected Host header for a loopback binding.' });
        return;
      }
      // A browser-initiated cross-site write announces itself. CLI and test
      // clients send no such header, so absence stays allowed.
      if (request.method !== 'GET' && request.headers['sec-fetch-site'] === 'cross-site') {
        await reply.code(403).send({ error: 'Cross-site requests are not accepted.' });
      }
      return;
    }
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
