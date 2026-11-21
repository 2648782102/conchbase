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

/**
 * A text document attached to a turn.
 *
 * Text is the one "other modality" every model accepts, and it is what people
 * actually paste: a log, a CSV, a config file, a stack trace. Sending it as an
 * attachment rather than pasting it into the message keeps the transcript
 * readable — the reader sees "attached error.log", not two thousand lines — and
 * lets the Runtime bound and label it.
 *
 * It is deliberately **not** an arbitrary binary type. A PDF or a .docx needs a
 * parser inside the Runtime, and a parser that runs on user bytes is a much
 * larger surface than anything else here. Refusing is honest; pretending to
 * support a file the model would receive as mojibake is not.
 */
export interface TextAttachment {
  readonly kind: 'text';
  /** File name shown to the reader and to the model. */
  readonly name: string;
  readonly mediaType: 'text/plain' | 'text/markdown' | 'application/json' | 'text/csv';
  /** UTF-8 content, already bounded. */
  readonly text: string;
  readonly bytes: number;
  readonly truncated: boolean;
}

export type Attachment = ImageAttachment | TextAttachment;

/** 8 MB of decoded bytes: past this the request bodies get unreasonable. */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 4;
/**
 * Text attachments are bounded much lower: they are prompt, not payload.
 *
 * Deliberately below half the per-message total, so the aggregate limit is
 * reachable: a per-file limit at or above half makes "total" unable to bind, and
 * an unreachable check is worse than no check because it reads like protection.
 */
export const MAX_TEXT_ATTACHMENT_BYTES = 192 * 1024;
/** Total text attached to one message, across attachments. */
export const MAX_TEXT_BYTES_PER_MESSAGE = 512 * 1024;

const MEDIA_TYPES: readonly ImageAttachment['mediaType'][] = Object.freeze([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
]);
const TEXT_MEDIA_TYPES: readonly TextAttachment['mediaType'][] = Object.freeze([
  'text/plain', 'text/markdown', 'application/json', 'text/csv',
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

/**
 * Validates one attachment of either supported kind.
 *
 * Structured, not sniffed: the client says `kind: 'image'` or `kind: 'text'`,
 * and the shape that follows must match. A parser that guessed from content
 * would let a caller label bytes however it liked.
 */
export function parseAttachment(input: unknown): Attachment {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new AttachmentError('An attachment must be an object.');
  }
  const kind = (input as Record<string, unknown>).kind;
  if (kind === 'image') return parseImageAttachment(input);
  if (kind === 'text') return parseTextAttachment(input);
  throw new AttachmentError('Attachment kind must be image or text.');
}

/**
 * Validates one text attachment.
 *
 * The text is bounded twice: per file, and in total per message by the caller.
 * It is stored as plain UTF-8, not base64 — a text file a client already holds
 * as a string should not be round-tripped through an encoding that inflates it
 * by a third and hides encoding errors.
 */
export function parseTextAttachment(input: unknown): TextAttachment {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new AttachmentError('An attachment must be an object.');
  }
  const record = input as Record<string, unknown>;
  const allowed = new Set(['kind', 'name', 'mediaType', 'text']);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new AttachmentError(`Attachment has unknown fields: ${unknown.sort().join(', ')}.`);
  if (typeof record.name !== 'string' || record.name.trim().length === 0 || record.name.length > 200) {
    throw new AttachmentError('name must be a non-empty string of at most 200 characters.');
  }
  if (typeof record.mediaType !== 'string' || !TEXT_MEDIA_TYPES.includes(record.mediaType as TextAttachment['mediaType'])) {
    throw new AttachmentError('mediaType must be one of text/plain, text/markdown, application/json, text/csv.');
  }
  if (typeof record.text !== 'string') throw new AttachmentError('text must be a string.');
  /*
   * Reject NUL rather than stripping it: a text file with a NUL is a binary file
   * mislabelled as text, and silently repairing it would send the model
   * something the user did not attach.
   */
  if (record.text.includes('\u0000')) {
    throw new AttachmentError('text attachments must not contain NUL bytes; attach it as a file instead.');
  }
  const bytes = Buffer.byteLength(record.text, 'utf8');
  if (bytes > MAX_TEXT_ATTACHMENT_BYTES) {
    throw new AttachmentError(
      `text attachment is ${bytes} bytes; the limit is ${MAX_TEXT_ATTACHMENT_BYTES}.`,
    );
  }
  return Object.freeze({
    kind: 'text' as const,
    name: record.name.trim(),
    mediaType: record.mediaType as TextAttachment['mediaType'],
    text: record.text,
    bytes,
    truncated: false,
  });
}

export function parseAttachments(input: unknown): readonly Attachment[] {
  if (input === undefined) return Object.freeze([]);
  if (!Array.isArray(input)) throw new AttachmentError('attachments must be an array.');
  if (input.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new AttachmentError(`At most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments are allowed per message.`);
  }
  const parsed = input.map(parseAttachment);
  const textBytes = parsed.reduce((total, entry) => total + (entry.kind === 'text' ? entry.bytes : 0), 0);
  if (textBytes > MAX_TEXT_BYTES_PER_MESSAGE) {
    throw new AttachmentError(
      `text attachments total ${textBytes} bytes; the limit is ${MAX_TEXT_BYTES_PER_MESSAGE}.`,
    );
  }
  return Object.freeze(parsed);
}

/**
 * Drops attachments until they fit a byte budget.
 *
 * Oldest first, because a follow-up question is usually about what was just
 * shown; dropping the newest image is how a model answers about something it
 * cannot see.
 */
export function fitAttachments(
  attachments: readonly Attachment[],
  maxBytes: number,
): { readonly kept: readonly Attachment[]; readonly dropped: number; readonly bytes: number } {
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
