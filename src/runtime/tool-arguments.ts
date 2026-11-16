/**
 * Canonical digest for tool arguments.
 *
 * Sorted keys make the digest order-independent, so `{a,b}` and `{b,a}` are the
 * same call. This matters because it is the identity used for read-result reuse
 * and for the durable `argumentsDigest` on tool events: two digests that differ
 * only by key order would defeat both.
 */
export function digestArguments(args: Readonly<Record<string, string | number | boolean | null>>): string {
  const canonical = Object.keys(args).sort().map((key) => `${key}=${String(args[key])}`).join('&');
  let hash = 0;
  for (let index = 0; index < canonical.length; index += 1) {
    hash = (hash * 31 + canonical.charCodeAt(index)) >>> 0;
  }
  return `arg_${hash.toString(16).padStart(8, '0')}`;
}
