/**
 * Error categories and bounded log payloads.
 *
 * The point is that one category label plus a few identifiers is enough to
 * diagnose almost everything, while prompts, tool arguments, model output, and
 * secrets are exactly what must never be logged.
 */

export type ErrorCategory =
  | 'validation'
  | 'not-found'
  | 'conflict'
  | 'auth'
  | 'rate-limit'
  | 'timeout'
  | 'provider'
  | 'unavailable'
  | 'internal';

export interface ErrorRecord {
  readonly category: ErrorCategory;
  readonly status: number;
  /** Short, non-sensitive message safe for logs and clients. */
  readonly message: string;
  readonly requestId?: string;
  readonly taskId?: string;
  readonly attempt?: number;
}

const STATUS: Record<ErrorCategory, number> = {
  validation: 400,
  auth: 401,
  'not-found': 404,
  conflict: 409,
  'rate-limit': 429,
  unavailable: 503,
  provider: 502,
  timeout: 504,
  internal: 500,
};

/** Removes control characters and bounds the message length. */
export function safeMessage(value: unknown, max = 300): string {
  const text = value instanceof Error ? value.message : String(value ?? 'Unknown error.');
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Classifies an arbitrary error by its name/status without leaking its body. */
export function categorizeError(cause: unknown): ErrorCategory {
  const name = (cause as { name?: string })?.name ?? '';
  const status = (cause as { statusCode?: number })?.statusCode;
  if (status && status >= 400 && status < 500) {
    if (status === 400) return 'validation';
    if (status === 401 || status === 403) return 'auth';
    if (status === 404) return 'not-found';
    if (status === 409) return 'conflict';
    if (status === 429) return 'rate-limit';
  }
  if (status === 504) return 'timeout';
  if (status === 503) return 'unavailable';
  if (status === 502) return 'provider';
  if (status && status >= 500) return 'internal';
  const text = safeMessage(cause).toLowerCase();
  if (/validation|must be|invalid|required|unknown field|not an object/.test(`${name} ${text}`.toLowerCase())) return 'validation';
  if (/notfound|not found/.test(`${name} ${text}`.toLowerCase())) return 'not-found';
  if (/conflict|already|cannot be/.test(`${name} ${text}`.toLowerCase())) return 'conflict';
  if (/timeout|timed out|exceeded its time budget/.test(text)) return 'timeout';
  if (/rate.?limit/.test(text)) return 'rate-limit';
  if (/provider|upstream|gateway/.test(text)) return 'provider';
  if (/unavailable|not configured|misconfigured/.test(text)) return 'unavailable';
  return 'internal';
}

export function toErrorRecord(
  cause: unknown,
  context: { requestId?: string; taskId?: string; attempt?: number } = {},
): ErrorRecord {
  const category = categorizeError(cause);
  return {
    category,
    status: STATUS[category],
    message: safeMessage(cause),
    ...(context.requestId ? { requestId: context.requestId } : {}),
    ...(context.taskId ? { taskId: context.taskId } : {}),
    ...(typeof context.attempt === 'number' ? { attempt: context.attempt } : {}),
  };
}

/**
 * A single structured log line. It deliberately omits the raw message: an
 * error message can quote a prompt, a file path, or a tool argument. Callers
 * that need the details should look at the (already bounded) event log, not
 * this operational line.
 */
export function formatErrorLog(record: ErrorRecord): string {
  return JSON.stringify({
    level: record.status >= 500 ? 'error' : 'warn',
    category: record.category,
    status: record.status,
    messageLength: record.message.length,
    ...(record.requestId ? { requestId: record.requestId } : {}),
    ...(record.taskId ? { taskId: record.taskId } : {}),
    ...(typeof record.attempt === 'number' ? { attempt: record.attempt } : {}),
  });
}
