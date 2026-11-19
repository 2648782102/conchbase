/**
 * A deterministic in-process provider for tests.
 *
 * It implements the same `ModelProvider` contract a real adapter does, so a
 * test that passes here exercises the Runtime's provider-neutral path rather
 * than a bespoke fake wired directly into the loop.
 */
import type { ProviderToolCall } from './model-adapter.js';
import {
  ProviderError,
  type ModelDescriptor,
  type ModelProvider,
  type ProviderRequest,
  type ProviderStreamEvent,
} from './model-provider.js';

export type FakeTurn =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'tool_calls'; readonly content?: string; readonly calls: readonly ProviderToolCall[] }
  | { readonly kind: 'error'; readonly kindOf: 'authentication' | 'rate-limit' | 'timeout' | 'context-limit' | 'invalid-request' | 'upstream-failure' | 'unavailable'; readonly message?: string };

export interface FakeProviderOptions {
  readonly id?: string;
  readonly models?: readonly ModelDescriptor[];
  readonly turns: readonly FakeTurn[];
  /** Artificial delay between stream events, in ms. Default 0. */
  readonly delayMs?: number;
}

export class FakeProvider implements ModelProvider {
  readonly id: string;
  private readonly models: readonly ModelDescriptor[];
  private readonly turns: readonly FakeTurn[];
  private readonly delayMs: number;
  private index = 0;

  constructor(options: FakeProviderOptions) {
    this.id = options.id ?? 'fake';
    this.models = options.models ?? Object.freeze([
      { id: 'fake/model', displayName: 'Fake Model', supportsStreaming: true, supportsTools: true, suitableForBoss: true },
    ]);
    this.turns = options.turns;
    this.delayMs = options.delayMs ?? 0;
  }

  async listModels(): Promise<readonly ModelDescriptor[]> {
    return this.models;
  }

  async *streamTurn(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    if (request.signal?.aborted) throw new ProviderError('timeout', 'aborted before start', { retryable: false });
    const turn = this.turns[Math.min(this.index, this.turns.length - 1)];
    this.index += 1;
    if (!turn) throw new ProviderError('upstream-failure', 'fake provider has no turns');

    if (turn.kind === 'error') {
      throw new ProviderError(turn.kindOf, turn.message ?? `fake ${turn.kindOf}`);
    }
    if (turn.kind === 'tool_calls') {
      yield { kind: 'tool_calls', content: turn.content ?? '', calls: turn.calls };
      return;
    }
    // Stream the text in small chunks so cancellation and partial output are
    // exercised, not skipped.
    const chunkSize = Math.max(1, Math.ceil(turn.text.length / 4));
    for (let offset = 0; offset < turn.text.length; offset += chunkSize) {
      if (request.signal?.aborted) throw new ProviderError('timeout', 'aborted mid-stream', { retryable: false });
      if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      yield { kind: 'text', delta: turn.text.slice(offset, offset + chunkSize) };
    }
    yield { kind: 'final', output: turn.text };
  }

  /** Number of turns consumed so far; useful for assertions. */
  get consumed(): number {
    return this.index;
  }
}
