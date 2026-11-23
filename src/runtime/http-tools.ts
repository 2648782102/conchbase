import { contentDigest } from './digest.js';
import {
  createBoundedResourceFetcher,
  MAX_HTTP_BYTES,
  type HttpFetchOptions,
} from './http-fetch-boundary.js';
import {
  ToolRejectedError,
  type ToolArguments,
  type ToolDefinition,
  type ToolExecutionResult,
  type ToolProvider,
} from './tool-provider.js';
import { optionalString, requiredString } from './tool-parameter.js';
import { createBuiltinWebExtractTool } from './web-extract.js';

export { isForbiddenAddress, MAX_HTTP_BYTES } from './http-fetch-boundary.js';
export type HttpToolsOptions = HttpFetchOptions;

const ALLOWED_METHODS = Object.freeze(['GET', 'HEAD'] as const);
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
