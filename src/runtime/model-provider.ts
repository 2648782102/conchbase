/**
 * The one provider contract the Runtime depends on.
 *
 * Domain code (task loop, Boss, chat) must never know a provider's URL, headers,
 * or wire format. Adapters implement this interface; everything above it stays
 * provider-neutral.
 */
import type { ProviderMessage, ProviderToolCall, ProviderToolDefinition } from './model-adapter.js';

export type ProviderErrorKind =
  | 'unavailable'
  | 'authentication'
  | 'rate-limit'
  | 'timeout'
  | 'invalid-request'
  | 'context-limit'
  | 'upstream-failure';

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly retryable: boolean;
  constructor(kind: ProviderErrorKind, message: string, options: { retryable?: boolean } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.retryable = options.retryable ?? (kind === 'rate-limit' || kind === 'timeout' || kind === 'unavailable');
  }
}

export interface ModelDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly contextTokens?: number;
  readonly supportsStreaming?: boolean;
  readonly supportsTools?: boolean;
  readonly supportsReasoning?: boolean;
  /** Whether the model is a reasonable default for Boss planning. */
  readonly suitableForBoss?: boolean;
}

export interface ProviderRequest {
  readonly taskId: string;
  readonly messages: readonly ProviderMessage[];
  readonly tools?: readonly ProviderToolDefinition[];
  readonly reasoningEffort?: 'low' | 'medium' | 'high';
  readonly signal?: AbortSignal;
}

export type ProviderStreamEvent =
  | { readonly kind: 'text'; readonly delta: string }
  | { readonly kind: 'final'; readonly output: string }
  | { readonly kind: 'tool_calls'; readonly content: string; readonly calls: readonly ProviderToolCall[] };

export interface ModelProvider {
  /** Stable adapter identity, e.g. 'magpie'. Not a product dependency. */
  readonly id: string;
  listModels(signal?: AbortSignal): Promise<readonly ModelDescriptor[]>;
  /** Streams one turn; callers consume events and may abort via `signal`. */
  streamTurn(request: ProviderRequest): AsyncIterable<ProviderStreamEvent>;
}

/** Maps an HTTP status/lowercased body hint to a provider error kind. */
export function classifyProviderFailure(status: number, body: string): ProviderErrorKind {
  const text = body.toLowerCase();
  if (status === 401 || status === 403) return 'authentication';
  if (status === 429) return 'rate-limit';
  if (status === 408 || /timeout|timed out/.test(text)) return 'timeout';
  if (status === 400 || status === 422) {
    if (/context|token limit|too long|maximum context/.test(text)) return 'context-limit';
    return 'invalid-request';
  }
  if (status === 404) return 'invalid-request';
  if (status >= 500) return 'upstream-failure';
  if (/context|token limit/.test(text)) return 'context-limit';
  return 'upstream-failure';
}
