/**
 * Live provider contract probe.
 *
 * Uses the Runtime's own config parser, provider registry, catalog client, and
 * streaming adapter. It lists models, streams one bounded reply, then asks for
 * a deliberately unknown model and reports the classified failure. Every line
 * is passed through a redactor before it reaches stdout or stderr.
 */
import {
  defaultProviderId,
  listProviders,
  resolveProviderEndpoint,
  unconfiguredProviderMessage,
} from '../runtime/provider-registry.js';
import { loadRuntimeConfig } from '../config/runtime-config.js';
import { MagpieModelCatalog } from '../runtime/model-catalog.js';
import {
  ModelProviderError,
  OpenAiChatCompletionsProvider,
} from '../runtime/magpie-provider.js';
import { categorizeError } from '../runtime/error-categories.js';

const SECRET_PATTERNS: readonly RegExp[] = Object.freeze([
  /sk-[a-zA-Z0-9_-]{8,}/g,
  /ghp_[a-zA-Z0-9]{8,}/g,
  /github_pat_[a-zA-Z0-9_]{8,}/g,
  /magpie-[a-zA-Z0-9_-]{8,}/g,
  /Bearer\s+[a-zA-Z0-9._~+/=-]{8,}/gi,
  /(?:api[_-]?key|access[_-]?token|password|secret|credential|private[_-]?key)\s*[:=]\s*["']?[^\s"',}]{4,}/gi,
]);

export function redactProviderOutput(value: string): string {
  return SECRET_PATTERNS.reduce(
    (text, pattern) => text.replace(pattern, '[REDACTED]'),
    String(value),
  ).replace(/\r/g, '');
}

function classify(cause: unknown): string {
  if (cause instanceof ModelProviderError) return categorizeError(cause);
  if (cause instanceof Error && /unavailable|invalid JSON|no response stream/i.test(cause.message)) return 'unavailable';
  return categorizeError(cause);
}

export interface ProviderProbeStream {
  write(value: string): unknown;
}

export interface ProviderProbeOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly stdout?: ProviderProbeStream;
  readonly stderr?: ProviderProbeStream;
}

export async function runProviderContract(options: ProviderProbeOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const write = (stream: ProviderProbeStream, value: string) => stream.write(`${redactProviderOutput(value)}\n`);
  let config;
  try {
    config = loadRuntimeConfig(env);
  } catch (cause) {
    write(stderr, `FAIL  configuration        ${cause instanceof Error ? cause.message : String(cause)}`);
    return 2;
  }

  const providerId = env.CONCHBASE_PROBE_PROVIDER
    ?? (config.providerEndpoints?.['openai-compatible'] ? 'openai-compatible' : defaultProviderId());
  const endpoint = resolveProviderEndpoint(providerId, {
    magpieBaseUrl: config.magpieBaseUrl,
    ...(config.magpieAppKey ? { magpieAppKey: config.magpieAppKey } : {}),
    ...(config.providerEndpoints ? { providers: config.providerEndpoints } : {}),
  });

  if (!endpoint) {
    write(stderr, `Provider '${providerId}' is not configured. Set CONCHBASE_PROVIDER_ENDPOINTS or CONCHBASE_MAGPIE_URL. ${unconfiguredProviderMessage(providerId)}`);
    return 2;
  }

  const modelId = env.CONCHBASE_PROBE_MODEL ?? config.defaultModel;
  const catalog = new MagpieModelCatalog({
    baseUrl: endpoint.baseUrl,
    ...(endpoint.appKey ? { appKey: endpoint.appKey } : {}),
    fetch: fetchImpl,
  });
  write(stdout, `ok    endpoint            ${providerId} ${endpoint.baseUrl} credential=${endpoint.appKey ? '[REDACTED]' : 'none'}`);

  const adapter = (model: string) => new OpenAiChatCompletionsProvider({
    baseUrl: endpoint.baseUrl,
    model,
    ...(endpoint.appKey ? { appKey: endpoint.appKey } : {}),
    appKeyFormat: endpoint.id === defaultProviderId() ? 'magpie' : 'opaque',
    fetch: fetchImpl,
  });

  try {
    const catalogStarted = Date.now();
    const models = await catalog.listModels(fetchImpl);
    write(stdout, `ok    catalog            ${models.length} model(s) in ${Date.now() - catalogStarted}ms`);

    if (!models.some((model) => model.id === modelId)) {
      write(stdout, `warn  model              ${modelId} is not in the catalog; probing it anyway`);
    }

    let output = '';
    const streamStarted = Date.now();
    const turn = await adapter(modelId).streamTurn({
      taskId: 'provider-contract-probe',
      prompt: 'Reply with exactly: PROBE_OK',
      turnIndex: 0,
      onOutputDelta(delta: string) {
        if (output.length < 200) output += delta;
      },
    });
    if (turn.kind !== 'final') throw new Error('The streaming probe did not produce a final text reply.');
    write(stdout, `ok    streaming          ${Date.now() - streamStarted}ms; ${output.replace(/\s+/g, ' ').trim().slice(0, 80) || '(empty)'}`);

    const failureStarted = Date.now();
    let failure: { readonly category: string; readonly message: string };
    try {
    await adapter('conchbase-unknown-model-probe').streamTurn({
        taskId: 'provider-contract-failure-probe',
        prompt: 'Reply with exactly: PROBE_OK',
        turnIndex: 0,
        onOutputDelta() {},
      });
    failure = { category: 'validation', message: 'The endpoint accepted an unknown model.' };
    } catch (cause) {
      failure = {
        category: classify(cause),
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }
    write(stdout, `ok    failure-category   ${failure.category} in ${Date.now() - failureStarted}ms; ${failure.message}`);
    write(stdout, `registered providers: ${listProviders().map((provider) => provider.id).join(', ')}`);
    return 0;
  } catch (cause) {
    write(stderr, `FAIL  provider-contract  ${classify(cause)}: ${cause instanceof Error ? cause.message : String(cause)}`);
    return 1;
  }
}
