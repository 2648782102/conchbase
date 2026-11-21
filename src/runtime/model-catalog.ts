import { sortEfforts } from './reasoning-effort.js';

export interface ModelCatalogEntry {
  readonly id: string;
  readonly displayName: string;
  /** Total context window in tokens, when the provider reports it. */
  readonly contextTokens?: number;
  readonly supportsStreaming?: boolean;
  readonly supportsTools?: boolean;
  readonly supportsReasoning?: boolean;
  /**
   * The effort tokens this model accepts, weakest first.
   *
   * Read from the gateway rather than inferred from the model id: the same
   * catalogue mixes `none/low/high/max`, `low/medium/high/xhigh/ultra`, a lone
   * `high`, and models with reasoning but no published levels at all. An absent
   * list means "this model has no effort control"; an empty list means the
   * gateway says it reasons but offers no choice.
   */
  readonly reasoningLevels?: readonly string[];
  /** Whether this model is a reasonable default for Boss planning. */
  readonly suitableForBoss?: boolean;
}

/** Read `reasoning_levels`, falling back to `supported_reasoning_levels[].effort`. */
function reasoningLevelsOf(record: Record<string, unknown>): readonly string[] | undefined {
  const direct = record.reasoning_levels;
  if (Array.isArray(direct)) {
    return sortEfforts(direct.filter((level): level is string =>
      typeof level === 'string' && level.length > 0 && level.length <= 32));
  }
  const supported = record.supported_reasoning_levels;
  if (Array.isArray(supported)) {
    const efforts = supported.flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null) return [];
      const effort = (entry as Record<string, unknown>).effort;
      return typeof effort === 'string' && effort.length > 0 && effort.length <= 32 ? [effort] : [];
    });
    return sortEfforts(efforts);
  }
  return undefined;
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
        /*
         * The gateway's own answer, not a guess from the model id.
         *
         * The previous rule was `/reason|think|thinking/i.test(id)`, which read
         * `deepseek-flash` as "no reasoning" while the gateway listed four
         * levels for it, and read `gemini-4-hydrogen` as reasoning-capable
         * while never learning that it also accepts `xhigh`.
         */
        const levels = reasoningLevelsOf(record);
        const claimsReasoning = record.reasoning === true || levels !== undefined;
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
          supportsReasoning: textOnly && claimsReasoning,
          ...(textOnly && levels !== undefined ? { reasoningLevels: levels } : {}),
          suitableForBoss: textOnly && (contextTokens ?? 0) >= 32_000,
        }];
      }));
    } catch {
      throw new Error('Model catalog is unavailable.');
    }
  }
}
