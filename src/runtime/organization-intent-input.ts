import { createHash } from 'node:crypto';
import { contentDigest } from './digest.js';
import { containsSecretLike } from './secret-filter.js';

/**
 * Admission for one Boss intent.
 *
 * This is the boundary where untrusted input becomes a validated submission.
 * It lives on its own because admission rules change for reasons unrelated to
 * execution: a new bound, a new optional field, a new screening rule. Keeping
 * them inside the 1500-line service meant every such change risked touching
 * dispatch logic.
 */

export type BossIntentSource = 'primary-conversation' | 'agent-chat';

export interface BossModeSubmitInput {
  readonly text: string;
  readonly idempotencyKey: string;
  readonly modelOverride?: {
    readonly providerId: string;
    readonly modelId: string;
  };
  readonly reasoningEffort?: 'low' | 'medium' | 'high';
  readonly source?: BossIntentSource;
  readonly conversation?: readonly {
    readonly author: 'user' | 'assistant';
    readonly body: string;
  }[];
  readonly onProgress?: (progress: {
    readonly state: 'streaming' | 'organizing';
    readonly percent: number | null;
    readonly previousText?: string;
  }) => void;
}

export class BossModeServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BossModeServiceError';
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function reference(value: string, length = 24): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

/** Full `sha256:` digest of a value. Re-exported for callers in this layer. */
export const digest = contentDigest;

export function intentId(idempotencyKey: string): string {
  return `int_${contentDigest(`intent:${idempotencyKey}`).slice(7, 31)}`;
}

/**
 * Turns one untrusted input into a validated submission, or throws.
 *
 * Unknown fields are rejected rather than dropped: a model or client that sends
 * an unexpected key has a wrong mental model, and silently ignoring it hides the
 * mismatch until behaviour surprises someone.
 */
export function validateSubmission(input: unknown): BossModeSubmitInput {
  if (!isRecord(input)) throw new BossModeServiceError('Boss mode intent must be an object.');
  const allowed = new Set(['text', 'idempotencyKey', 'source']);
  const conversation = isRecord(input.conversation) || Array.isArray(input.conversation)
    ? input.conversation
    : undefined;
  const unknown = Object.keys(input).filter((key) =>
    !allowed.has(key) && key !== 'conversation' && key !== 'onProgress'
      && key !== 'modelOverride' && key !== 'reasoningEffort');
  if (unknown.length > 0) throw new BossModeServiceError(`Unknown fields: ${unknown.sort().join(', ')}.`);
  if (typeof input.text !== 'string' || input.text.trim().length === 0 || input.text.length > 20_000) {
    throw new BossModeServiceError('text must be a non-empty string of at most 20000 characters.');
  }
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0 || input.idempotencyKey.length > 200) {
    throw new BossModeServiceError('idempotencyKey must be a non-empty string of at most 200 characters.');
  }
  if (containsSecretLike(`${input.text} ${input.idempotencyKey}`)) {
    throw new BossModeServiceError('Boss mode intent contains secret-like content.');
  }
  let boundedConversation: readonly { readonly author: 'user' | 'assistant'; readonly body: string }[] | undefined;
  if (conversation !== undefined) {
    if (!Array.isArray(conversation) || conversation.length > 8) {
      throw new BossModeServiceError('conversation must contain at most 8 bounded messages.');
    }
    boundedConversation = Object.freeze(conversation.map((item, index) => {
      if (!isRecord(item) || (item.author !== 'user' && item.author !== 'assistant')
        || typeof item.body !== 'string' || item.body.length === 0 || item.body.length > 6000
        || containsSecretLike(item.body)) {
        throw new BossModeServiceError(`conversation[${index}] is not a bounded safe message.`);
      }
      return Object.freeze({ author: item.author, body: item.body });
    }));
  }
  if (input.source !== undefined && input.source !== 'primary-conversation' && input.source !== 'agent-chat') {
    throw new BossModeServiceError('source must be primary-conversation or agent-chat.');
  }
  let modelOverride: { readonly providerId: string; readonly modelId: string } | undefined;
  if (input.modelOverride !== undefined) {
    if (!isRecord(input.modelOverride)
      || typeof input.modelOverride.providerId !== 'string'
      || typeof input.modelOverride.modelId !== 'string') {
      throw new BossModeServiceError('modelOverride must contain providerId and modelId.');
    }
    modelOverride = Object.freeze({
      providerId: input.modelOverride.providerId,
      modelId: input.modelOverride.modelId,
    });
  }
  if (input.reasoningEffort !== undefined
    && input.reasoningEffort !== 'low'
    && input.reasoningEffort !== 'medium'
    && input.reasoningEffort !== 'high') {
    throw new BossModeServiceError('reasoningEffort must be low, medium, or high.');
  }
  return Object.freeze({
    text: input.text,
    idempotencyKey: input.idempotencyKey,
    ...(typeof input.onProgress === 'function'
      ? { onProgress: input.onProgress as NonNullable<BossModeSubmitInput['onProgress']> }
      : {}),
    ...(input.source ? { source: input.source } : {}),
    ...(modelOverride ? { modelOverride } : {}),
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
    ...(boundedConversation ? { conversation: boundedConversation } : {}),
  });
}

/**
 * Bounds any thrown value into a string safe to publish.
 *
 * A non-Error still carries a diagnostic; collapsing every one of them into
 * "unknown failure" is what previously hid a real cause.
 */
export function boundedError(cause: unknown): string {
  let message: string;
  if (cause instanceof Error) {
    message = cause.message;
  } else if (typeof cause === 'string') {
    message = cause;
  } else {
    try {
      message = JSON.stringify(cause) ?? String(cause);
    } catch {
      message = String(cause);
    }
  }
  const bounded = message.trim().length > 0 ? message : 'Unknown execution failure.';
  return bounded.slice(0, 240).replace(/[\u0000-\u001f\u007f]/g, ' ');
}
