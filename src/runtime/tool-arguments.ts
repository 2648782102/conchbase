import { createHash } from 'node:crypto';

/**
 * Canonical digest for tool arguments.
 *
 * Sorted keys make the digest order-independent, so `{a,b}` and `{b,a}` are the
 * same call. This matters because it is the identity used for read-result reuse
 * and for the durable `argumentsDigest` on tool events: two digests that differ
 * only by key order would defeat both.
 *
 * The identity has to be collision-resistant and unambiguous. String
 * concatenation (`key=value&`) let `{a:'1&b=2'}` and `{a:'1',b:'2'}` produce the
 * same input, and a 32-bit rolling hash collides by birthday around 65k calls —
 * either one would make "this write already ran" answer for the wrong call.
 */
export function digestArguments(args: Readonly<Record<string, string | number | boolean | null>>): string {
  const canonical = JSON.stringify(
    Object.keys(args).sort().map((key) => [key, args[key] ?? null]),
  );
  return `arg_${createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 24)}`;
}
