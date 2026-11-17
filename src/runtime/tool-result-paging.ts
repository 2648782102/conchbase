/**
 * Bounded tool results that tell the model what it did not see and how to get
 * it. A silent truncation teaches the model that the first 8 KiB is the whole
 * answer; an explicit footer lets it ask for the next slice instead.
 */

export interface PageableResult {
  /** The already-decoded text of the tool result. */
  readonly text: string;
  /** Byte cap applied to the slice returned to the model. */
  readonly maxBytes: number;
  /**
   * How the model can request more, expressed in the tool's own arguments.
   * Omitted when the tool cannot continue (for example a single fixed value).
   */
  readonly continuation?: {
    readonly argument: string;
    readonly nextValue: number;
    readonly unit: 'byte' | 'item';
    /**
     * Bytes the caller knows about beyond this slice (for example the rest of a
     * file). Defaults to the length of `text`, which is only correct when the
     * caller handed over the whole remaining body.
     */
    readonly totalBytes?: number;
  };
}

export interface PagedResult {
  readonly summary: string;
  readonly bytes: number;
  readonly truncated: boolean;
  readonly continuationArgument: string | null;
  readonly continuationValue: number | null;
}

const TRUNCATION_MARKER = '\n\n[truncated]';

export function pageToolResult(input: PageableResult): PagedResult {
  const buffer = Buffer.from(input.text, 'utf8');
  if (buffer.byteLength <= input.maxBytes) {
    return Object.freeze({
      summary: input.text,
      bytes: buffer.byteLength,
      truncated: false,
      continuationArgument: null,
      continuationValue: null,
    });
  }

  // Reserve room for the footer so the truncated body plus the notice still
  // fit inside the caller's byte cap.
  const footer = input.continuation
    ? buildFooter(input.continuation, buffer.byteLength)
    : TRUNCATION_MARKER;
  const budget = Math.max(0, input.maxBytes - Buffer.byteLength(footer, 'utf8'));
  const body = truncateUtf8(buffer, budget);
  const summary = `${body}${footer}`;
  return Object.freeze({
    summary,
    bytes: Buffer.byteLength(summary, 'utf8'),
    truncated: true,
    continuationArgument: input.continuation?.argument ?? null,
    continuationValue: input.continuation?.nextValue ?? null,
  });
}

function buildFooter(
  continuation: NonNullable<PageableResult['continuation']>,
  totalBytes: number,
): string {
  const bytes = continuation.totalBytes ?? totalBytes;
  return `\n\n[truncated: ${bytes} bytes total. Continue with ${continuation.argument}=${continuation.nextValue}.]`;
}

function truncateUtf8(buffer: Buffer, budget: number): string {
  if (budget <= 0) return '';
  if (budget >= buffer.length) return buffer.toString('utf8');

  // Walk back over continuation bytes to the last lead byte, then decide whether
  // that whole character fits. Cutting inside a character would emit U+FFFD.
  let end = budget;
  let leadIndex = end - 1;
  while (leadIndex >= 0 && (buffer[leadIndex]! & 0xc0) === 0x80) leadIndex -= 1;
  if (leadIndex < 0) return '';
  const lead = buffer[leadIndex]!;
  const width = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  if (leadIndex + width > budget) end = leadIndex;
  return buffer.subarray(0, end).toString('utf8');
}
