import type { ModelAdapter, ModelAdapterInput, ModelTurn } from './model-adapter.js';

export interface MagpieProviderConfig {
  readonly baseUrl: string;
  readonly model: string;
  readonly appKey?: string;
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

export class ModelProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelProviderError';
  }
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

export class OpenAiChatCompletionsProvider implements ModelAdapter {
  private readonly endpoint: string;
  private readonly model: string;
  private readonly appKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(config: MagpieProviderConfig) {
    if (config.model.trim().length === 0) {
      throw new ModelProviderError('Model id must not be empty.');
    }
    if (config.appKey !== undefined && !/^magpie-[a-zA-Z0-9_-]+$/.test(config.appKey)) {
      throw new ModelProviderError('Magpie app key has an invalid format.');
    }
    this.endpoint = `${normalizeBaseUrl(config.baseUrl)}/chat/completions`;
    this.model = config.model;
    this.appKey = config.appKey;
    this.timeoutMs = config.timeoutMs ?? 120_000;
    this.fetchImpl = config.fetch ?? globalThis.fetch;
  }

  async nextTurn(input: ModelAdapterInput): Promise<ModelTurn> {
    if (input.turnIndex !== 0) {
      throw new ModelProviderError('This provider supports one model turn per task attempt.');
    }
    if (input.prompt.trim().length === 0) {
      throw new ModelProviderError('Task prompt must not be empty.');
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'Conchbase/0.2.0',
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
          messages: [{ role: 'user', content: input.prompt }],
        }),
        signal,
      });
    } catch (cause) {
      if (input.signal?.aborted) throw cause;
      throw new ModelProviderError('Model provider request failed.');
    }

    if (!response.ok) {
      throw new ModelProviderError(`Model provider returned HTTP ${response.status}.`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ModelProviderError('Model provider returned invalid JSON.');
    }

    const choice = (payload as ChatCompletionResponse | null)?.choices?.[0];
    const message = choice?.message;
    if (message?.tool_calls !== undefined) {
      throw new ModelProviderError('Model tool calls are not supported in this runtime slice.');
    }
    if (typeof message?.content !== 'string' || message.content.trim().length === 0) {
      throw new ModelProviderError('Model provider returned an empty completion.');
    }

    return Object.freeze({ kind: 'final', output: message.content });
  }
}
