import type {
  ModelAdapterInput,
  ProviderMessage,
  ProviderModelTurn,
  StreamingModelTurn,
  StructuredModelAdapter,
} from './model-adapter.js';
import {
  ProviderToolCallError,
  parseOpenAiChatCompletionsToolCall,
} from './provider-tool-call.js';
import type { ToolCallArguments } from './tool-request.js';
import { classifyProviderFailure } from './model-provider.js';

function parseToolArguments(raw: string): ToolCallArguments {
  if (raw.trim().length === 0) return Object.freeze({});
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ModelProviderError('Model provider returned malformed tool arguments.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ModelProviderError('Model provider returned malformed tool arguments.');
  }
  const bounded: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (key.length === 0 || key.length > 120) continue;
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      bounded[key] = value;
    }
  }
  return Object.freeze(bounded);
}

export interface MagpieProviderConfig {
  readonly baseUrl: string;
  readonly model: string;
  readonly appKey?: string;
  /**
   * How strictly `appKey` is validated.
   *
   * Magpie issues keys of the form `magpie-…`, so its adapter rejects anything
   * else as an obvious misconfiguration. The same wire implementation serves a
   * plain OpenAI-compatible endpoint, whose keys have no such prefix. Defaulting
   * to the strict rule keeps the Magpie path unchanged; a second adapter opts
   * out instead of failing with a message about a product it does not use.
   */
  readonly appKeyFormat?: 'magpie' | 'opaque';
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

interface ChatCompletionResponse {
  readonly choices?: readonly {
    readonly message?: {
      readonly content?: string | null;
      readonly tool_calls?: unknown;
    };
  }[];
}

interface ChatCompletionChunk {
  readonly choices?: readonly {
    readonly delta?: {
      readonly content?: string | null;
      readonly reasoning_content?: string | null;
      readonly tool_calls?: unknown;
    };
    readonly finish_reason?: string | null;
  }[];
}

export interface StreamingTurnInput extends ModelAdapterInput {
  readonly onOutputDelta: (delta: string) => void;
}

export interface StreamingModelAdapter {
  streamTurn(input: StreamingTurnInput): Promise<StreamingModelTurn>;
}

export const STREAMING_OUTPUT_LIMITS = Object.freeze({
  chunkCharacters: 4000,
  outputCharacters: 100_000,
  deltaChunks: 5000,
});

export class ModelProviderError extends Error {
  /** Provider-neutral failure class; see model-provider.ts ProviderErrorKind. */
  readonly kind: import('./model-provider.js').ProviderErrorKind;
  readonly retryable: boolean;
  constructor(message: string, kind: import('./model-provider.js').ProviderErrorKind = 'upstream-failure') {
    super(message);
    this.name = 'ModelProviderError';
    this.kind = kind;
    this.retryable = kind === 'rate-limit' || kind === 'timeout' || kind === 'unavailable';
  }
}

/**
 * Translates Conchbase's internal provider-message shape into the OpenAI Chat
 * Completions wire format. The internal shape uses camelCase (`toolCalls`,
 * `toolCallId`) because it is a Runtime contract; the wire format is snake_case
 * and requires `tool_call_id` for every tool result. Sending the internal shape
 * verbatim makes a model see a tool result it cannot correlate with the call
 * that produced it, which is why a model would loop on a tool it already ran.
 */
function toOpenAiMessages(
  messages: readonly ProviderMessage[],
): readonly Record<string, unknown>[] {
  return messages.map((message) => {
    if (message.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: message.toolCallId,
        content: message.content,
      };
    }
    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: message.content,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: {
            name: call.name,
            arguments: JSON.stringify(call.arguments ?? {}),
          },
        })),
      };
    }
    /*
     * A user turn with images becomes a content-part array, which is the shape
     * every OpenAI-compatible vision endpoint accepts. Text stays a string when
     * there are no images, so a text-only provider sees exactly what it saw
     * before.
     */
    if (message.role === 'user' && message.images && message.images.length > 0) {
      return {
        role: 'user',
        content: [
          ...(message.content.length > 0 ? [{ type: 'text', text: message.content }] : []),
          ...message.images.map((image) => ({
            type: 'image_url',
            image_url: { url: image.dataUrl },
          })),
        ],
      };
    }
    return { role: message.role, content: message.content };
  });
}

function normalizeBaseUrl(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new ModelProviderError('Model provider base URL is invalid.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ModelProviderError('Model provider base URL must use HTTP or HTTPS.');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new ModelProviderError('Model provider base URL must not contain credentials.');
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!['127.0.0.1', 'localhost', '::1'].includes(hostname)) {
    throw new ModelProviderError('Model provider must use a loopback base URL.');
  }
  parsed.hash = '';
  parsed.search = '';
  parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/v1`;
  return parsed.toString().replace(/\/$/, '');
}

/**
 * A transport failure is not the upstream's answer.
 *
 * Refused connections, DNS errors, TLS failures, and socket resets all mean
 * "cannot reach the gateway", which is retryable and independent of the request
 * body. Wrapping them as an upstream failure made an unreachable endpoint look
 * like a bad response and hid the retry hint.
 */
function transportFailure(cause: unknown): ModelProviderError {
  const timedOut = cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError');
  return new ModelProviderError(
    timedOut ? 'Model provider request timed out.' : 'Model provider is unreachable.',
    timedOut ? 'timeout' : 'unavailable',
  );
}

export class OpenAiChatCompletionsProvider implements StructuredModelAdapter, StreamingModelAdapter {
  private readonly endpoint: string;
  private readonly model: string;
  private readonly appKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(config: MagpieProviderConfig) {
    if (config.model.trim().length === 0) {
      throw new ModelProviderError('Model id must not be empty.');
    }
    if (config.appKey !== undefined
      && (config.appKeyFormat ?? 'magpie') === 'magpie'
      && !/^magpie-[a-zA-Z0-9_-]+$/.test(config.appKey)) {
      throw new ModelProviderError('Magpie app key has an invalid format.');
    }
    if (config.appKey !== undefined && config.appKey.length === 0) {
      throw new ModelProviderError('Provider credential must not be empty.');
    }
    this.endpoint = `${normalizeBaseUrl(config.baseUrl)}/chat/completions`;
    this.model = config.model;
    this.appKey = config.appKey;
    this.timeoutMs = config.timeoutMs ?? 120_000;
    this.fetchImpl = config.fetch ?? globalThis.fetch;
  }

  async nextTurn(input: ModelAdapterInput): Promise<ProviderModelTurn> {
    if (input.turnIndex < 0) {
      throw new ModelProviderError('This provider supports one model turn per task attempt.');
    }
    if (input.prompt.trim().length === 0) {
      throw new ModelProviderError('Task prompt must not be empty.');
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'Conchbase/1.0.0',
    };
    if (this.appKey) headers.Authorization = `Bearer ${this.appKey}`;

    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = input.signal
      ? AbortSignal.any([input.signal, timeout])
      : timeout;

    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.model,
          stream: false,
          messages: input.messages ?? [{ role: 'user', content: input.prompt }],
        }),
        signal,
      });
    } catch (cause) {
      if (input.signal?.aborted) throw cause;
      throw transportFailure(cause);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new ModelProviderError(
        `Model provider returned HTTP ${response.status}.`,
        classifyProviderFailure(response.status, body),
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ModelProviderError('Model provider returned invalid JSON.');
    }

    const observation = this.parseToolCallObservation(payload);
    if (observation) {
      return Object.freeze({ kind: 'tool_call_observation', observation });
    }
    const choice = (payload as ChatCompletionResponse | null)?.choices?.[0];
    const message = choice?.message;
    if (typeof message?.content !== 'string' || message.content.trim().length === 0) {
      throw new ModelProviderError('Model provider returned an empty completion.');
    }

    return Object.freeze({ kind: 'final', output: message.content });
  }

  async streamTurn(input: StreamingTurnInput): Promise<StreamingModelTurn> {
    if (input.turnIndex < 0) {
      throw new ModelProviderError('This provider supports one model turn per task attempt.');
    }
    if (input.prompt.trim().length === 0) {
      throw new ModelProviderError('Task prompt must not be empty.');
    }
    if (input.signal?.aborted) throw input.signal.reason;

    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      'User-Agent': 'Conchbase/1.0.0',
    };
    if (this.appKey) headers.Authorization = `Bearer ${this.appKey}`;

    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = input.signal
      ? AbortSignal.any([input.signal, timeout])
      : timeout;

    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.model,
          stream: true,
          messages: toOpenAiMessages(input.messages ?? [{ role: 'user', content: input.prompt }]),
          ...(input.reasoningEffort ? { reasoning_effort: input.reasoningEffort } : {}),
          ...(input.tools && input.tools.length > 0
            ? {
              tools: input.tools.map((tool) => ({
                type: 'function',
                function: {
                  name: tool.id,
                  description: tool.description,
                  parameters: tool.parameters,
                },
              })),
            }
            : {}),
        }),
        signal,
      });
    } catch (cause) {
      if (input.signal?.aborted) throw cause;
      throw transportFailure(cause);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new ModelProviderError(
        `Model provider returned HTTP ${response.status}.`,
        classifyProviderFailure(response.status, body),
      );
    }
    if (!response.body) {
      throw new ModelProviderError('Model provider returned no response stream.');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let output = '';
    let observation: StreamingModelTurn | null = null;
    const toolCalls: { id: string; name: string; arguments: string }[] = [];
    let deltaCount = 0;
    let sawDone = false;

    const processLine = (line: string): void => {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith(':')) return;
      if (!trimmed.startsWith('data:')) {
        throw new ModelProviderError('Model provider returned an invalid stream frame.');
      }
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') {
        sawDone = true;
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(data);
      } catch {
        throw new ModelProviderError('Model provider returned invalid stream JSON.');
      }
      const choice = (payload as ChatCompletionChunk | null)?.choices?.[0];
      const delta = choice?.delta;
      if (delta?.tool_calls !== undefined) {
        if (!Array.isArray(delta.tool_calls) || delta.tool_calls.length === 0) {
          throw new ModelProviderError('Model provider returned an unsupported tool call.');
        }
        for (const candidate of delta.tool_calls as readonly {
          readonly index?: number;
          readonly id?: string;
          readonly function?: { readonly name?: string; readonly arguments?: string };
        }[]) {
          const index = candidate.index ?? 0;
          const current = toolCalls[index] ?? { id: '', name: '', arguments: '' };
          toolCalls[index] = {
            id: candidate.id ?? current.id,
            name: candidate.function?.name ?? current.name,
            arguments: current.arguments + (candidate.function?.arguments ?? ''),
          };
        }
        return;
      }
      const message = (payload as ChatCompletionResponse | null)?.choices?.[0]?.message;
      const parsedObservation = message !== undefined
        ? this.parseToolCallObservation(payload)
        : null;
      if (parsedObservation) {
        if (observation || output.length > 0 || sawDone) {
          throw new ModelProviderError('Model provider returned a mixed tool-call response.');
        }
        observation = Object.freeze({ kind: 'tool_call_observation', observation: parsedObservation });
        return;
      }
      if (typeof delta?.content !== 'string' || delta.content.length === 0) return;
      if (observation) {
        throw new ModelProviderError('Model provider returned a mixed tool-call response.');
      }
      if (delta.content.length > STREAMING_OUTPUT_LIMITS.chunkCharacters) {
        throw new ModelProviderError('Model provider returned an oversized output chunk.');
      }
      deltaCount += 1;
      if (deltaCount > STREAMING_OUTPUT_LIMITS.deltaChunks) {
        throw new ModelProviderError('Model provider exceeded the output chunk limit.');
      }
      output += delta.content;
      if (output.length > STREAMING_OUTPUT_LIMITS.outputCharacters) {
        throw new ModelProviderError('Model provider exceeded the output length limit.');
      }
      input.onOutputDelta(delta.content);
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, '');
          buffer = buffer.slice(newline + 1);
          processLine(line);
          newline = buffer.indexOf('\n');
        }
        if (sawDone) break;
      }
      buffer += decoder.decode();
      if (buffer.trim().length > 0) processLine(buffer.replace(/\r$/, ''));
    } catch (cause) {
      if (input.signal?.aborted) throw cause;
      if (cause instanceof ModelProviderError) throw cause;
      throw new ModelProviderError('Model provider stream failed.');
    } finally {
      if (!sawDone) await reader.cancel().catch(() => undefined);
    }

    if (input.signal?.aborted) {
      throw new ModelProviderError('Model provider stream was interrupted.');
    }
    if (!sawDone) {
      throw new ModelProviderError('Model provider stream ended before completion.');
    }
    if (toolCalls.length > 0) {
      if (observation) throw new ModelProviderError('Model provider returned a mixed tool-call response.');
      const parsedCalls = toolCalls.filter((call) => call.name.length > 0);
      if (parsedCalls.length === 0) {
        throw new ModelProviderError('Model provider returned an unsupported tool call.');
      }
      return Object.freeze({
        kind: 'tool_calls',
        content: output,
        calls: Object.freeze(parsedCalls.map((call, index) => Object.freeze({
          id: call.id.length > 0 ? call.id : `call_${index}`,
          name: call.name,
          arguments: parseToolArguments(call.arguments),
        }))),
      });
    }
    if (observation) {
      if (input.signal?.aborted) {
        throw new ModelProviderError('Model provider stream was interrupted.');
      }
      return observation;
    }
    if (output.trim().length === 0) {
      throw new ModelProviderError('Model provider returned an empty completion.');
    }
    return Object.freeze({ kind: 'final', output });
  }

  private parseToolCallObservation(payload: unknown) {
    try {
      return parseOpenAiChatCompletionsToolCall(payload);
    } catch (cause) {
      if (cause instanceof ProviderToolCallError) {
        throw new ModelProviderError('Model provider returned an unsupported tool call.');
      }
      throw cause;
    }
  }
}
