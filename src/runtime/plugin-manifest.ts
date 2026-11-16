import type { ToolSideEffect } from './tool-provider.js';

/**
 * Plugin declarations.
 *
 * A manifest is intentionally data-only. It names tools and their side-effect
 * class; the Runtime still decides whether an Agent may invoke them and whether
 * a consequential call needs approval. Nothing here can grant itself access.
 */

export const PLUGIN_MANIFEST_VERSION = 1;
export const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/;
export const TOOL_ID_PATTERN = /^[a-z][a-z0-9_.-]{1,63}$/;
export const MAX_TOOLS_PER_PLUGIN = 32;
export const MAX_DESCRIPTION = 280;

export class PluginManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginManifestError';
  }
}

export interface PluginToolDeclaration {
  readonly id: string;
  readonly description: string;
  readonly sideEffect: ToolSideEffect;
  readonly parameters?: Readonly<Record<string, unknown>>;
}

export interface PluginManifest {
  readonly version: typeof PLUGIN_MANIFEST_VERSION;
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tools: readonly PluginToolDeclaration[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value !== 'object' || value === null || Array.isArray(value) ? false : true;
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new PluginManifestError(`${label} has unknown fields: ${unknown.sort().join(', ')}`);
  }
}

function boundedString(value: unknown, label: string, pattern?: RegExp, max = MAX_DESCRIPTION): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw new PluginManifestError(`${label} must be a non-empty string of at most ${max} characters.`);
  }
  const candidate = value.trim();
  if (pattern && !pattern.test(candidate)) {
    throw new PluginManifestError(`${label} must match ${String(pattern)}.`);
  }
  return candidate;
}

function parseTool(value: unknown, index: number): PluginToolDeclaration {
  if (!isRecord(value)) throw new PluginManifestError(`tools[${index}] must be an object.`);
  assertExactKeys(value, ['id', 'description', 'sideEffect', 'parameters'], `tools[${index}]`);
  const sideEffect = value.sideEffect;
  if (sideEffect !== 'read' && sideEffect !== 'write' && sideEffect !== 'external') {
    throw new PluginManifestError(`tools[${index}].sideEffect must be read, write, or external.`);
  }
  const parsed: {
    id: string;
    description: string;
    sideEffect: PluginToolDeclaration['sideEffect'];
    parameters?: Readonly<Record<string, unknown>>;
  } = {
    id: boundedString(value.id, `tools[${index}].id`, TOOL_ID_PATTERN, 64),
    description: boundedString(value.description, `tools[${index}].description`),
    sideEffect,
  };
  if (value.parameters !== undefined) {
    if (!isRecord(value.parameters)) {
      throw new PluginManifestError(`tools[${index}].parameters must be an object.`);
    }
    parsed.parameters = Object.freeze({ ...value.parameters });
  }
  return Object.freeze(parsed);
}

/** Parses one untrusted plugin manifest into a bounded declaration. */
export function parsePluginManifest(value: unknown): PluginManifest {
  if (!isRecord(value)) throw new PluginManifestError('Plugin manifest must be an object.');
  assertExactKeys(value, ['version', 'id', 'name', 'description', 'tools'], 'plugin manifest');
  if (value.version !== PLUGIN_MANIFEST_VERSION) {
    throw new PluginManifestError(`Unsupported plugin manifest version: ${String(value.version)}.`);
  }
  if (!Array.isArray(value.tools) || value.tools.length === 0 || value.tools.length > MAX_TOOLS_PER_PLUGIN) {
    throw new PluginManifestError(`tools must contain 1 to ${MAX_TOOLS_PER_PLUGIN} entries.`);
  }
  const tools = value.tools.map(parseTool);
  if (new Set(tools.map((tool) => tool.id)).size !== tools.length) {
    throw new PluginManifestError('tools must not contain duplicate ids.');
  }
  return Object.freeze({
    version: PLUGIN_MANIFEST_VERSION,
    id: boundedString(value.id, 'plugin id', PLUGIN_ID_PATTERN, 64),
    name: boundedString(value.name, 'plugin name', undefined, 80),
    description: boundedString(value.description, 'plugin description'),
    tools: Object.freeze(tools),
  });
}
