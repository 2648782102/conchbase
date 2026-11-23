/**
 * HTTP fetch for the Agent, with a real SSRF boundary.
 *
 * A plain `fetch(url)` given a model-supplied string is a Server-Side Request
 * Forgery primitive: `http://169.254.169.254/` is a cloud metadata service,
 * `http://127.0.0.1:4318/v1/tasks` is this Runtime's own API, and
 * `http://[::1]:6379/` is whatever else listens on loopback. None of that is
 * reachable from the browser the user typed into, so none of it should be
 * reachable from a model either.
 *
 * The boundary is enforced in three places, because one is not enough:
 *
 * 1. **Before the request**, on the parsed URL — scheme, credentials, and the
 *    resolved address of the hostname.
 * 2. **On every redirect**, re-checking the new URL. Following redirects blindly
 *    lets a public URL bounce to `127.0.0.1`, which is the standard bypass.
 * 3. **On the response**, bounding size and body type before it reaches the
 *    model's context.
 *
 * A permission level may make this require approval; it may not widen the
 * boundary. That is the same rule `decidePolicy` applies to files, and the
 * reason `allowPrivateNetworks` is an operator flag rather than something a
 * request or Agent can set.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { contentDigest } from './digest.js';
import {
  ToolRejectedError,
  type ToolArguments,
  type ToolDefinition,
  type ToolExecutionResult,
  type ToolProvider,
} from './tool-provider.js';
import { optionalString, requiredString } from './tool-parameter.js';
import { createBuiltinWebExtractTool } from './web-extract.js';

export const MAX_HTTP_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 3;
const ALLOWED_METHODS = Object.freeze(['GET', 'HEAD'] as const);
const TEXTUAL = /^(text\/|application\/(json|xml|javascript|x-ndjson)\b)/i;

export interface HttpToolsOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  /**
   * Whether requests to private, loopback, and link-local addresses are
   * allowed.
   *
   * Off by default and operator-only. Turning it on is a deliberate decision to
   * let the Agent call services on this machine or its LAN; it is not something
   * a model output or an Agent revision can request.
   */
  readonly allowPrivateNetworks?: boolean;
  /** Injected for tests: resolves a hostname to its addresses. */
  readonly resolve?: (hostname: string) => Promise<readonly string[]>;
}

/**
 * Ranges that must not be reachable from a model-supplied URL.
 *
 * Covers loopback, private, link-local, unique-local, carrier-grade NAT, and
 * documentation/test space, for v4 and v6. Erring toward "blocked" is correct: a
 * false positive costs one refused request, a false negative exposes the host's
 * internal services.
 */
export function isForbiddenAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isForbiddenV4(address);
  if (version === 6) return isForbiddenV6(address);
  return true;
}

function isForbiddenV4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true;                          // 0.0.0.0/8
  if (a === 10) return true;                         // private
  if (a === 127) return true;                        // loopback
  if (a === 100 && b >= 64 && b <= 127) return true;  // carrier-grade NAT
  if (a === 169 && b === 254) return true;           // link-local, incl. metadata
  if (a === 172 && b >= 16 && b <= 31) return true;   // private
  if (a === 192 && b === 168) return true;           // private
  if (a === 192 && b === 0) return true;             // 192.0.0.0/24, 192.0.2.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51) return true;            // documentation
  if (a === 203 && b === 0) return true;             // documentation
  if (a >= 224) return true;                         // multicast and reserved
  return false;
}

function isForbiddenV6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === '::' || normalized === '::1') return true;
  /*
   * IPv4-mapped addresses (`::ffff:127.0.0.1`) reach the same host. The embedded
   * address is checked as v4, otherwise the v6 form bypasses every v4 rule.
   */
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mapped) return isForbiddenV4(mapped[1]!);
  if (normalized.startsWith('fe80')) return true;     // link-local
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // unique-local
  if (normalized.startsWith('ff')) return true;       // multicast
  return false;
}

interface ParsedTarget {
  readonly url: URL;
  readonly addresses: readonly string[];
}

export interface BoundedResource {
  readonly body: string;
  readonly bytes: number;
  readonly truncated: boolean;
  readonly contentType: string;
  readonly status: number;
  readonly finalUrl: URL;
  readonly redirects: number;
}

/**
 * Parses and vets one URL, resolving its hostname.
 *
 * Resolution is part of the check, not an optimisation: a hostname that resolves
 * to `127.0.0.1` is the same request as writing the address out, and checking
 * only the literal text would miss it.
 */
async function vetUrl(
  raw: string,
  options: {
    readonly allowPrivateNetworks: boolean;
    readonly resolve: (host: string) => Promise<readonly string[]>;
  },
): Promise<ParsedTarget> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ToolRejectedError('invalid_url', 'url must be an absolute http or https URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ToolRejectedError('unsupported_scheme', 'only http and https are allowed.');
  }
  // Credentials in a URL are both a leak and a smuggling vector; a secret
  // belongs in a SecretHandle, never in a URL the model wrote.
  if (url.username !== '' || url.password !== '') {
    throw new ToolRejectedError('url_contains_credentials');
  }
  if (options.allowPrivateNetworks) return { url, addresses: [] };

  const host = url.hostname.replace(/^\[|\]$/g, '');
  const literal = isIP(host);
  const addresses = literal ? [host] : await options.resolve(host);
  if (addresses.length === 0) {
    throw new ToolRejectedError('host_unresolvable', 'hostname did not resolve.');
  }
  if (addresses.some((address) => isForbiddenAddress(address))) {
    throw new ToolRejectedError(
      'private_network_blocked',
      'the target resolves to a private, loopback, or link-local address',
    );
  }
  return { url, addresses };
}

export function createBoundedResourceFetcher(options: HttpToolsOptions = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const maxBytes = Math.max(1_024, Math.min(MAX_HTTP_BYTES, options.maxBytes ?? MAX_HTTP_BYTES));
  const allowPrivateNetworks = options.allowPrivateNetworks === true;
  const resolveHost = options.resolve ?? (async (host: string) => {
    const records = await lookup(host, { all: true, verbatim: true });
    return records.map((record) => record.address);
  });

  const fetchBoundedResource = async (
    raw: string,
    method: 'GET' | 'HEAD',
  ): Promise<BoundedResource> => {
    const allowedTypes = TEXTUAL;
    let target = await vetUrl(raw, { allowPrivateNetworks, resolve: resolveHost });
    let redirects = 0;
    for (;;) {
      const response = await fetchImpl(target.url.toString(), {
        method,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          'user-agent': 'Conchbase/1.0.0',
          accept: 'text/*, application/json, application/xml;q=0.9, */*;q=0.1',
        },
      });
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location !== null) {
        if (redirects >= MAX_REDIRECTS) throw new ToolRejectedError('too_many_redirects');
        redirects += 1;
        target = await vetUrl(new URL(location, target.url).toString(), {
          allowPrivateNetworks,
          resolve: resolveHost,
        });
        continue;
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (method === 'HEAD') {
        return Object.freeze({
          body: '',
          bytes: 0,
          truncated: false,
          contentType,
          status: response.status,
          finalUrl: target.url,
          redirects,
        });
      }
      if (!allowedTypes.test(contentType)) {
        throw new ToolRejectedError(
          'unsupported_content_type',
          `response content-type is ${contentType.slice(0, 80) || 'missing'}; only textual responses are returned.`,
        );
      }
      const body = await readBounded(response, maxBytes);
      if (!response.ok) {
        throw new ToolRejectedError(
          'http_error',
          `HTTP ${response.status}${body.text.length > 0 ? `: ${body.text.slice(0, 200)}` : ''}`,
        );
      }
      return Object.freeze({
        body: body.text,
        bytes: body.text.length,
        truncated: body.truncated,
        contentType,
        status: response.status,
        finalUrl: target.url,
        redirects,
      });
    }
  };

  return fetchBoundedResource;
}

export function createBuiltinHttpTools(options: HttpToolsOptions = {}): ToolProvider {
  const fetchBoundedResource = createBoundedResourceFetcher(options);
  const maxBytes = Math.max(1_024, Math.min(MAX_HTTP_BYTES, options.maxBytes ?? MAX_HTTP_BYTES));
  const webExtract = createBuiltinWebExtractTool(options);

  const definitions: readonly ToolDefinition[] = Object.freeze([
    Object.freeze({
      id: 'http_fetch',
      version: 1,
      description: [
        'Fetch one http or https URL and return bounded textual content.',
        'GET and HEAD only; redirects are followed at most three times and re-checked.',
        'Private, loopback, and link-local addresses are refused unless the operator allows them.',
      ].join(' '),
      sideEffect: 'external',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Absolute http or https URL.' },
          method: { type: 'string', enum: ['GET', 'HEAD'], description: 'Defaults to GET.' },
        },
        required: ['url'],
        additionalProperties: false,
      },
    }),
  ]);

  async function fetchOnce(args: ToolArguments): Promise<ToolExecutionResult> {
    const raw = requiredString(args, 'url');
    if (raw.length > 2_000) throw new ToolRejectedError('url_too_long');
    const methodRaw = optionalString(args, 'method', 'GET').toUpperCase();
    if (!(ALLOWED_METHODS as readonly string[]).includes(methodRaw)) {
      throw new ToolRejectedError('unsupported_method', 'only GET and HEAD are allowed.');
    }
    const method = methodRaw as 'GET' | 'HEAD';
    const resource = await fetchBoundedResource(raw, method);
    if (method === 'HEAD') {
      return Object.freeze({
        ok: true,
        summary: `HEAD ${resource.finalUrl} → ${resource.status}`,
        digest: contentDigest(`http:${method}:${resource.finalUrl}:${resource.status}`),
        bytes: 0,
        evidence: {
          facts: {
            url: resource.finalUrl.toString(),
            status: resource.status,
            contentType: resource.contentType.slice(0, 120),
          },
        },
      });
    }
    return Object.freeze({
      ok: true,
      summary: resource.truncated
        ? `${resource.body}\n\n[truncated at ${maxBytes} bytes]`
        : resource.body,
      digest: contentDigest(resource.body),
      bytes: resource.bytes,
      truncated: resource.truncated,
      evidence: {
        facts: {
          url: resource.finalUrl.toString(),
          status: resource.status,
          contentType: resource.contentType.slice(0, 120),
          bytes: resource.bytes,
          truncated: resource.truncated,
          redirects: resource.redirects,
        },
      },
    });
  }

  return Object.freeze({
    list: () => Object.freeze([...definitions, ...webExtract.list()]),
    has: (toolId: string) => toolId === 'http_fetch' || toolId === 'web_extract',
    invoke: (toolId: string, args: ToolArguments) => {
      if (toolId === 'web_extract') return webExtract.invoke(toolId, args);
      if (toolId === 'http_fetch') return fetchOnce(args);
      throw new ToolRejectedError('unknown_tool');
    },
  });
}

/**
 * Reads at most `maxBytes`, then stops.
 *
 * `response.text()` would buffer the whole body first — a 2 GB response would be
 * in memory before the cap applied. Reading the stream makes the cap a real
 * bound rather than a report about something that already happened.
 */
async function readBounded(
  response: Response,
  maxBytes: number,
): Promise<{ readonly text: string; readonly truncated: boolean }> {
  const body = response.body;
  if (!body) return { text: '', truncated: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (total + value.byteLength > maxBytes) {
      chunks.push(value.slice(0, maxBytes - total));
      total = maxBytes;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  return { text: buffer.toString('utf8'), truncated };
}
