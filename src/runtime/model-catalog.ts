export interface ModelCatalogEntry {
  readonly id: string;
  readonly displayName: string;
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
      'User-Agent': 'Conchbase/0.9.0',
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
        return [{
          id: record.id,
          displayName: typeof record.display_name === 'string'
            ? record.display_name
            : record.id,
        }];
      }));
    } catch {
      throw new Error('Model catalog is unavailable.');
    }
  }
}
