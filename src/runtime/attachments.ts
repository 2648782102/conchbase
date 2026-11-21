/**
 * Image attachments on a user turn.
 *
 * The Runtime had no way to accept one: every message was text, and a client
 * that wanted to show the model a screenshot had nowhere to put it. This adds
 * the smallest honest slice — an image supplied as a `data:` URL, validated,
 * bounded, and carried to the provider in a format it already understands.
 *
 * Why a data URL rather than a path or a remote URL:
 *
 * - a path would let a message name any file on the host, and the model would
 *   read outside the workspace with the user's privileges;
 * - a remote URL would make the provider fetch an arbitrary address, turning a
 *   chat message into an SSRF primitive and leaking that this Runtime asked.
 *
 * Both are refusals, not limitations to work around: an attachment is bytes the
 * user chose to send, so it arrives as bytes.
 */
export interface ImageAttachment {
  readonly kind: 'image';
  /** Always `data:image/<type>;base64,<payload>`. */
  readonly dataUrl: string;
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  /** Decoded size in bytes, for the caller's own limits. */
  readonly bytes: number;
  /** Optional alt text; never required, never treated as instructions. */
  readonly alt?: string;
}

/** 8 MB of decoded bytes: past this the request bodies get unreasonable. */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 4;

const MEDIA_TYPES: readonly ImageAttachment['mediaType'][] = Object.freeze([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
]);
const DATA_URL = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/;

export class AttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentError';
  }
}

/**
 * Validates one attachment.
 *
 * The base64 alphabet is checked by the pattern rather than by decoding first,
 * so a malformed payload fails before it becomes a buffer.
 */
export function parseImageAttachment(input: unknown): ImageAttachment {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new AttachmentError('An attachment must be an object.');
  }
  const record = input as Record<string, unknown>;
  const allowed = new Set(['kind', 'dataUrl', 'alt']);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new AttachmentError(`Attachment has unknown fields: ${unknown.sort().join(', ')}.`);
  if (record.kind !== 'image') throw new AttachmentError('Only image attachments are supported.');
  if (typeof record.dataUrl !== 'string') throw new AttachmentError('dataUrl must be a string.');
  const match = DATA_URL.exec(record.dataUrl);
  if (!match) {
    throw new AttachmentError('dataUrl must be a base64 data URL for png, jpeg, webp, or gif.');
  }
  const mediaType = match[1] as ImageAttachment['mediaType'];
  if (!MEDIA_TYPES.includes(mediaType)) throw new AttachmentError('Unsupported image type.');
  const payload = match[2] ?? '';
  // 4 base64 characters encode 3 bytes; padding shortens the last group.
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  const bytes = Math.floor((payload.length * 3) / 4) - padding;
  if (bytes <= 0) throw new AttachmentError('Attachment is empty.');
  if (bytes > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentError(`Attachment is ${bytes} bytes; the limit is ${MAX_ATTACHMENT_BYTES}.`);
  }
  const alt = record.alt;
  if (alt !== undefined && (typeof alt !== 'string' || alt.length > 500)) {
    throw new AttachmentError('alt must be a string of at most 500 characters.');
  }
  return Object.freeze({
    kind: 'image' as const,
    dataUrl: record.dataUrl,
    mediaType,
    bytes,
    ...(typeof alt === 'string' && alt.length > 0 ? { alt } : {}),
  });
}

export function parseAttachments(input: unknown): readonly ImageAttachment[] {
  if (input === undefined) return Object.freeze([]);
  if (!Array.isArray(input)) throw new AttachmentError('attachments must be an array.');
  if (input.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new AttachmentError(`At most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments are allowed per message.`);
  }
  return Object.freeze(input.map(parseImageAttachment));
}

/**
 * Drops attachments until they fit a byte budget.
 *
 * Oldest first, because a follow-up question is usually about what was just
 * shown; dropping the newest image is how a model answers about something it
 * cannot see.
 */
export function fitAttachments(
  attachments: readonly ImageAttachment[],
  maxBytes: number,
): { readonly kept: readonly ImageAttachment[]; readonly dropped: number; readonly bytes: number } {
  const kept = [...attachments];
  let bytes = kept.reduce((total, entry) => total + entry.bytes, 0);
  let dropped = 0;
  while (kept.length > 0 && bytes > maxBytes) {
    const removed = kept.shift();
    if (!removed) break;
    bytes -= removed.bytes;
    dropped += 1;
  }
  return Object.freeze({ kept: Object.freeze(kept), dropped, bytes });
}
