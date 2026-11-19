/**
 * The one place that knows which provider adapters exist.
 *
 * Domain code asks this registry instead of hard-coding a provider name, so
 * adding an adapter is a change here plus its implementation — not a search
 * for every `'magpie'` literal.
 */

export interface ProviderDescriptor {
  readonly id: string;
  readonly displayName: string;
  /** True for the adapter used when a task does not choose one. */
  readonly isDefault: boolean;
}

/** Adapters compiled into this Runtime. Add one here when you add its code. */
const PROVIDERS: readonly ProviderDescriptor[] = Object.freeze([
  Object.freeze({ id: 'magpie', displayName: 'Magpie (OpenAI-compatible)', isDefault: true }),
  // A plain OpenAI-compatible endpoint configured by the operator. It shares
  // the adapter implementation with Magpie; only its base URL differs.
  Object.freeze({ id: 'openai-compatible', displayName: 'OpenAI-compatible endpoint', isDefault: false }),
]);

export function listProviders(): readonly ProviderDescriptor[] {
  return PROVIDERS;
}

export function defaultProviderId(): string {
  return PROVIDERS.find((provider) => provider.isDefault)?.id ?? PROVIDERS[0]!.id;
}

export function isSupportedProvider(id: string): boolean {
  return PROVIDERS.some((provider) => provider.id === id);
}

/** A resolved endpoint for one registered provider. */
export interface ProviderEndpoint {
  readonly id: string;
  readonly baseUrl: string;
  readonly appKey?: string;
}

export interface ProviderEndpointsConfig {
  readonly magpieBaseUrl: string;
  readonly magpieAppKey?: string;
  /**
   * Overrides for the non-default adapters. Only registered ids are accepted.
   *
   * Kept optional so a checkout with only Magpie configured behaves exactly as
   * before: a provider with no endpoint is simply not reachable, and the
   * registry says so instead of quietly borrowing Magpie's URL.
   */
  readonly providers?: Readonly<Record<string, { readonly baseUrl: string; readonly appKey?: string }>>;
}

/**
 * The base URL and credential a provider id actually resolves to.
 *
 * This is the only place that maps a provider identity to a network endpoint.
 * Returning `undefined` for an unconfigured provider is deliberate: callers
 * must fail with a clear message rather than fall back to another gateway.
 */
export function resolveProviderEndpoint(
  id: string,
  config: ProviderEndpointsConfig,
): ProviderEndpoint | undefined {
  if (!isSupportedProvider(id)) return undefined;
  if (id === defaultProviderId()) {
    return Object.freeze({
      id,
      baseUrl: config.magpieBaseUrl,
      ...(config.magpieAppKey ? { appKey: config.magpieAppKey } : {}),
    });
  }
  const override = config.providers?.[id];
  if (!override) return undefined;
  return Object.freeze({
    id,
    baseUrl: override.baseUrl,
    ...(override.appKey ? { appKey: override.appKey } : {}),
  });
}

/** One line a caller can show when a provider was registered but never configured. */
export function unconfiguredProviderMessage(id: string): string {
  const defaultId = defaultProviderId();
  return `Provider '${id}' is registered but has no endpoint configured. `
    + `Set its base URL, or use '${defaultId}'.`;
}

/** Message used by callers that reject an unknown provider. */
export function unsupportedProviderMessage(id: string): string {
  const known = PROVIDERS.map((provider) => provider.id).join(', ');
  return `Provider '${id}' is not available in this runtime. Supported providers: ${known}.`;
}

/** Loopback-only rule shared by every OpenAI-compatible adapter. */
export function isLoopbackBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    return ['127.0.0.1', '::1', 'localhost'].includes(host);
  } catch {
    return false;
  }
}
