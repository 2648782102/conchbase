/**
 * Retries a provider call that failed for a transient reason.
 *
 * Every adapter already classified its failures and set `retryable`, and
 * nothing read it: a single 429 or a one-off timeout failed the whole task, and
 * the only recovery was a person noticing and pressing retry. That turns a
 * network blip into a product failure, and it makes long runs fragile in
 * exactly the conditions where they are most valuable.
 *
 * What this deliberately does **not** retry:
 *
 * - anything the adapter did not mark retryable. A bad request, an
 *   authentication failure, and a context overflow are all deterministic: the
 *   same call produces the same error, so retrying only delays the message;
 * - a call the caller aborted. The user asked to stop, and a retry would
 *   contradict that;
 * - anything after the retry budget. Each attempt is bounded by the caller's
 *   signal, so a slow gateway cannot extend the run indefinitely.
 */
import { ProviderError } from './model-provider.js';
import { ModelProviderError } from './magpie-provider.js';

export interface RetryPolicy {
  /** Total attempts, including the first. */
  readonly attempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({
  attempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 4_000,
});

/**
 * Whether a thrown value is a provider failure that is worth repeating.
 *
 * Two shapes exist because the Runtime grew two adapters at different times;
 * both expose `retryable` and `kind`, and neither is imported by the domain
 * layer, so the check is structural rather than `instanceof`.
 */
export function retryableKind(cause: unknown): string | null {
  if (!(cause instanceof Error)) return null;
  if (cause instanceof ProviderError || cause instanceof ModelProviderError) {
    return cause.retryable ? cause.kind : null;
  }
  const candidate = cause as { retryable?: unknown; kind?: unknown };
  if (candidate.retryable === true && typeof candidate.kind === 'string') return candidate.kind;
  return null;
}

/** Exponential backoff with a cap. Attempt 1 waits `baseDelayMs`. */
export function retryDelayMs(attempt: number, policy: RetryPolicy): number {
  const exponential = policy.baseDelayMs * (2 ** Math.max(0, attempt - 1));
  return Math.min(policy.maxDelayMs, exponential);
}

export interface RetryOutcome<T> {
  readonly value: T;
  readonly attempts: number;
  /** The transient failures that were survived, in order. */
  readonly recovered: readonly string[];
}

export class RetryExhaustedError extends Error {
  readonly attempts: number;
  readonly kind: string;
  constructor(message: string, attempts: number, kind: string, cause: unknown) {
    super(message, { cause });
    this.name = 'RetryExhaustedError';
    this.attempts = attempts;
    this.kind = kind;
  }
}

/**
 * Runs `operation` with retries, honouring `signal` between attempts.
 *
 * `onRetry` is called before each wait so the caller can record a visible event:
 * a run that took four extra seconds because of two retries should say so, not
 * look slow for no reason.
 */
export async function withProviderRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: {
    readonly policy?: RetryPolicy;
    readonly signal?: AbortSignal;
    readonly onRetry?: (info: { attempt: number; kind: string; delayMs: number; error: unknown }) => void;
    readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  } = {},
): Promise<RetryOutcome<T>> {
  const policy = options.policy ?? DEFAULT_RETRY_POLICY;
  const sleep = options.sleep ?? abortableSleep;
  const recovered: string[] = [];

  for (let attempt = 1; attempt <= policy.attempts; attempt += 1) {
    if (options.signal?.aborted) throw new Error('Provider retry aborted by the caller.');
    try {
      const value = await operation(attempt);
      return Object.freeze({ value, attempts: attempt, recovered: Object.freeze(recovered) });
    } catch (cause) {
      const kind = retryableKind(cause);
      if (kind === null || attempt === policy.attempts) {
        if (kind !== null) {
          throw new RetryExhaustedError(
            `${providerMessage(cause)}（已尝试 ${attempt} 次）`,
            attempt,
            kind,
            cause,
          );
        }
        throw cause;
      }
      const delayMs = retryDelayMs(attempt, policy);
      recovered.push(kind);
      options.onRetry?.({ attempt, kind, delayMs, error: cause });
      await sleep(delayMs, options.signal);
    }
  }
  // Unreachable: the loop either returns or throws.
  throw new Error('Provider retry loop exited unexpectedly.');
}

function providerMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message.slice(0, 300) : 'Provider call failed.';
}

/**
 * Sleeps, but wakes immediately when the caller aborts.
 *
 * A plain `setTimeout` would keep a cancelled task waiting out its backoff, and
 * the user would see "cancelling" for seconds after asking to stop.
 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(timer);
      done();
    };
    function done() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
