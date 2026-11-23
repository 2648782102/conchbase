import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { containsSecretLike } from './secret-filter.js';
import { ToolRejectedError } from './tool-provider.js';

export const MAX_HTTP_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 3;

export interface HttpFetchOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly allowPrivateNetworks?: boolean;
  readonly resolve?: (hostname: string) => Promise<readonly string[]>;
  readonly allowedContentTypes?: RegExp;
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

interface ParsedTarget {
  readonly url: URL;
  readonly addresses: readonly string[];
}

/** Ranges a model-supplied URL must never reach. */
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
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && (b === 168 || b === 0)) return true;
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return true;
  if (a === 203 && b === 0) return true;
  return a >= 224;
}

function isForbiddenV6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === '::' || normalized === '::1') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mapped) return isForbiddenV4(mapped[1]!);
  return normalized.startsWith('fe80')
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || normalized.startsWith('ff');
}

async function vetUrl(
  raw: string,
  options: {
    readonly allowPrivateNetworks: boolean;
    readonly resolve: (hostname: string) => Promise<readonly string[]>;
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

export function createBoundedResourceFetcher(options: HttpFetchOptions = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const maxBytes = Math.max(1_024, Math.min(MAX_HTTP_BYTES, options.maxBytes ?? MAX_HTTP_BYTES));
  const allowPrivateNetworks = options.allowPrivateNetworks === true;
  const allowedContentTypes = options.allowedContentTypes
    ?? /^(text\/|application\/(json|xhtml\+xml|xml|javascript|x-ndjson)\b)/i;
  const resolveHost = options.resolve ?? (async (host: string) => {
    const records = await lookup(host, { all: true, verbatim: true });
    return records.map((record) => record.address);
  });

  return async (raw: string, method: 'GET' | 'HEAD'): Promise<BoundedResource> => {
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
      const isErrorResponse = !response.ok;
      if (method === 'HEAD') {
        return Object.freeze({
          body: '', bytes: 0, truncated: false, contentType,
          status: response.status, finalUrl: target.url, redirects,
        });
      }
      if (!isErrorResponse && !allowedContentTypes.test(contentType)) {
        const boundedType = contentType.slice(0, 80);
        throw new ToolRejectedError(
          'unsupported_content_type',
          `response content-type is ${containsSecretLike(boundedType) ? '(withheld)' : boundedType || 'missing'}; only textual responses are returned.`,
        );
      }
      const body = await readBounded(response, maxBytes);
      if (!response.ok) {
        const boundedDetail = body.text.slice(0, 200);
        const detail = body.text.length === 0
          ? ''
          : containsSecretLike(boundedDetail) ? ' [response body withheld]' : `: ${boundedDetail}`;
        throw new ToolRejectedError('http_error', `HTTP ${response.status}${detail}`);
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
}

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
