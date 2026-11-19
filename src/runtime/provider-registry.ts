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
