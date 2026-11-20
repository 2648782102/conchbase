import { createHash } from 'node:crypto';

/**
 * The two digest shapes this Runtime uses.
 *
 * Eleven modules had grown their own copy of one of these. They were identical
 * by coincidence rather than by construction, so a change to one — a different
 * hash, a different truncation — would have silently produced digests that no
 * longer matched their siblings.
 *
 * - `contentDigest` is the full `sha256:<hex>` form used where the digest is
 *   the evidence for a value (file contents, tool results).
 * - `referenceDigest` is a short `prefix_<hex>` form used where the digest is
 *   only an identifier (an event, a receipt), and a full hash would be noise.
 */

export function contentDigest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function referenceDigest(prefix: string, value: string): string {
  return `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}
