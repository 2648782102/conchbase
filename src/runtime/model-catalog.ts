export interface ModelCatalogEntry {
  readonly id: string;
  readonly displayName: string;
  /** Total context window in tokens, when the provider reports it. */
  readonly contextTokens?: number;
  readonly supportsStreaming?: boolean;
  readonly supportsTools?: boolean;
  readonly supportsReasoning?: boolean;
  /** Whether this model is a reasonable default for Boss planning. */
  readonly suitableForBoss?: boolean;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

export interface ModelCatalogClient {
  listModels(fetchImpl?: typeof globalThis.fetch): Promise<readonly ModelCatalogEntry[]>;
}

export interface MagpieModelCatalogConfig {
  readonly baseUrl: string;
  readonly appKey?: string;
  readonly fetch?: typeof globalThis.fetch;
}

export class MagpieModelCatalog implements ModelCatalogClient {
  private readonly baseUrl: string;
  private readonly appKey: string | undefined;
  private readonly fetchImpl: typeof globalThis.fetch | undefined;

  constructor(config: MagpieModelCatalogConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.appKey = config.appKey;
    this.fetchImpl = config.fetch;
  }

  async listModels(fetchImpl?: typeof globalThis.fetch): Promise<readonly ModelCatalogEntry[]> {
    const providerFetch = fetchImpl ?? this.fetchImpl ?? globalThis.fetch;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': 'Conchbase/1.0.0',
    };
    if (this.appKey) headers.Authorization = `Bearer ${this.appKey}`;

    try {
      const response = await providerFetch(`${this.baseUrl}/v1/models`, {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error('Model catalog request failed.');
      const payload: unknown = await response.json();
      const entries = (payload as { data?: unknown }).data;
      if (!Array.isArray(entries)) throw new Error('Model catalog response is invalid.');
      return Object.freeze(entries.flatMap((entry) => {
        if (typeof entry !== 'object' || entry === null) return [];
        const record = entry as Record<string, unknown>;
        if (typeof record.id !== 'string' || record.id.length === 0) return [];
        const contextTokens = positiveInt(record.context_length) ?? positiveInt(record.context_window)
          ?? positiveInt(record.max_input_tokens);
        const textOnly = Array.isArray(record.modalities)
          ? (record.modalities as { input?: readonly string[] }).input?.includes('text') ?? true
          : true;
        // Magpie's gateway is OpenAI-compatible for chat, streaming, and tools.
        // A model that cannot take text is not a chat model at all.
        return [{
          id: record.id,
          displayName: typeof record.display_name === 'string'
            ? record.display_name
            : record.id,
          ...(contextTokens ? { contextTokens } : {}),
          supportsStreaming: textOnly,
          supportsTools: textOnly,
          supportsReasoning: /reason|think|thinking/i.test(record.id),
          suitableForBoss: textOnly && (contextTokens ?? 0) >= 32_000,
        }];
      }));
    } catch {
      throw new Error('Model catalog is unavailable.');
    }
  }
}
