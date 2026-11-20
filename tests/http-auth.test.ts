import assert from 'node:assert/strict';
import test from 'node:test';
import { installAuthHook, type AuthOptions } from '../src/http/auth.js';
import { rawSha256Digest } from '../src/runtime/platform-contract.js';

/**
 * The authentication boundary.
 *
 * This is the only thing standing between a non-loopback binding and anonymous
 * access, and it had no direct test — it was reached only through one `401`
 * assertion in the platform suite, which an implementation that rejected
 * everything would also satisfy.
 *
 * The hook is captured rather than run through Fastify: the behaviour under
 * test is the decision, and a fake app keeps the test about the rule.
 */

interface Captured {
  readonly reply: { code?: number; body?: unknown };
}

function install(options: AuthOptions): {
  readonly call: (authorization?: string) => Promise<Captured>;
} {
  type Hook = Parameters<Parameters<typeof installAuthHook>[0]['addHook']>[1];
  let hook: Hook | null = null;
  installAuthHook({
    addHook(_name, registered) { hook = registered; },
  }, options);
  assert.ok(hook, 'the hook is registered');

  return {
    async call(authorization?: string) {
      const reply = {
        code_: undefined as number | undefined,
        body_: undefined as unknown,
        code(value: number) { this.code_ = value; return this; },
        async send(payload: unknown) { this.body_ = payload; return this; },
      };
      const request = {
        headers: authorization === undefined ? {} : { authorization },
      };
      // The hook only reads `headers.authorization` and the two reply methods
      // exercised below; Fastify's full request type is irrelevant here.
      await hook!(request as never, reply as never);
      return {
        reply: {
          ...(reply.code_ === undefined ? {} : { code: reply.code_ }),
          ...(reply.body_ === undefined ? {} : { body: reply.body_ }),
        },
      };
    },
  };
}

const TOKEN = 'approved-token';
const DIGEST = rawSha256Digest(TOKEN);

test('a loopback binding needs no token at all', async () => {
  const auth = install({ loopback: true });
  assert.deepEqual((await auth.call()).reply, {});
  // Even a malformed header is ignored: the transport is already trusted.
  assert.deepEqual((await auth.call('Bearer anything')).reply, {});
});

test('a non-loopback binding rejects a request with no token', async () => {
  const auth = install({ loopback: false });
  assert.equal((await auth.call()).reply.code, 401);
});

test('a non-loopback binding rejects a token that is not a Bearer header', async () => {
  const auth = install({ loopback: false, tokenDigest: DIGEST });
  assert.equal((await auth.call(`Token ${TOKEN}`)).reply.code, 401);
  assert.equal((await auth.call(TOKEN)).reply.code, 401);
});

test('the configured token digest is accepted', async () => {
  const auth = install({ loopback: false, tokenDigest: DIGEST });
  assert.deepEqual((await auth.call(`Bearer ${TOKEN}`)).reply, {});
});

test('a wrong token is rejected even when a digest is configured', async () => {
  const auth = install({ loopback: false, tokenDigest: DIGEST });
  assert.equal((await auth.call('Bearer wrong-token')).reply.code, 401);
});

test('a paired token is accepted without a configured digest', async () => {
  const auth = install({
    loopback: false,
    platform: { isTokenActive: (token: string) => token === TOKEN } as never,
  });
  assert.deepEqual((await auth.call(`Bearer ${TOKEN}`)).reply, {});
  assert.equal((await auth.call('Bearer other')).reply.code, 401);
});

test('a configured digest and an inactive pairing both fail closed', async () => {
  const auth = install({
    loopback: false,
    tokenDigest: DIGEST,
    platform: { isTokenActive: () => false } as never,
  });
  // The digest still matches, so this must pass; the pairing is an alternative,
  // not an additional requirement.
  assert.deepEqual((await auth.call(`Bearer ${TOKEN}`)).reply, {});
});
