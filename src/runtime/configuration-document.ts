import { createHash } from 'node:crypto';
import {
  CompositionValidationError,
  parseCompositionDocument,
  type CompositionLink,
  type CompositionNode,
} from './composition-document.js';

export type ConfigurationRevisionId = string & { readonly __brand: 'ConfigurationRevisionId' };
export type ConfigurationSource = 'inline' | 'file' | 'registry' | 'env';

export interface ConfigurationReference {
  readonly id: string;
  readonly label: string;
  readonly source: ConfigurationSource;
}

export interface ConfigurationComposition {
  readonly schemaVersion: 1;
  readonly name: string;
  readonly nodes: readonly CompositionNode[];
  readonly links: readonly CompositionLink[];
  readonly entryNodeIds: readonly string[];
  readonly metadata: Readonly<Record<string, string>>;
}

interface ConfigurationDocumentBase {
  readonly name: string;
  readonly skills: readonly ConfigurationReference[];
  readonly policies: readonly ConfigurationReference[];
  readonly mcpServers: readonly ConfigurationReference[];
  readonly plugins: readonly ConfigurationReference[];
  readonly secretRefs: readonly string[];
  readonly metadata: Readonly<Record<string, string>>;
}

export interface ConfigurationDocumentV1 extends ConfigurationDocumentBase {
  readonly schemaVersion: 1;
}

export interface ConfigurationDocumentV2 extends ConfigurationDocumentBase {
  readonly schemaVersion: 2;
  readonly composition: ConfigurationComposition;
}

export type ConfigurationDocument = ConfigurationDocumentV1 | ConfigurationDocumentV2;

export interface ConfigurationRevision {
  readonly id: ConfigurationRevisionId;
  readonly document: ConfigurationDocument;
  readonly appliedAt: string;
}

export interface ConfigurationRevisionSummary {
  readonly id: ConfigurationRevisionId;
  readonly name: string;
  readonly appliedAt: string;
}

export interface ValidationIssue {
  readonly path: string;
  readonly reason: string;
}

export class ConfigurationValidationError extends Error {
  readonly details: readonly ValidationIssue[];

  constructor(details: readonly ValidationIssue[]) {
    super('Configuration document does not match the versioned contract.');
    this.name = 'ConfigurationValidationError';
    this.details = Object.freeze([...details]);
  }
}

export const BOOTSTRAP_CONFIGURATION_DOCUMENT: ConfigurationDocumentV1 = Object.freeze({
  schemaVersion: 1,
  name: 'phase-1-single-turn',
  skills: Object.freeze([]),
  policies: Object.freeze([Object.freeze({
    id: 'no-model-tool-execution',
    label: 'Reject model-requested tools',
    source: 'inline',
  })]),
  mcpServers: Object.freeze([]),
  plugins: Object.freeze([]),
  secretRefs: Object.freeze([]),
  metadata: Object.freeze({ boundary: 'phase-1' }),
});

const SOURCES: readonly ConfigurationSource[] = [
  'inline',
  'file',
  'registry',
  'env',
];
const SECTIONS = ['skills', 'policies', 'mcpServers', 'plugins'] as const;
const BASE_KEYS = [
  'schemaVersion',
  'name',
  ...SECTIONS,
  'secretRefs',
  'metadata',
] as const;
const V2_KEYS = [...BASE_KEYS, 'composition'] as const;
const ID_PATTERN = /^[a-z][a-z0-9_.-]{0,127}$/;
const MAX_DOCUMENT_JSON_LENGTH = 20_000;
const MAX_NAME_LENGTH = 120;
const MAX_LABEL_LENGTH = 200;
const MAX_REFERENCES_PER_SECTION = 32;
const MAX_SECRET_REFS = 32;
const MAX_SECRET_REF_LENGTH = 200;
const MAX_METADATA_ENTRIES = 32;
const MAX_METADATA_KEY_LENGTH = 64;
const MAX_METADATA_VALUE_LENGTH = 500;
const SECRET_LIKE_KEY = /(?:api[_-]?key|token|password|secret|credential|private[_-]?key)/i;
const SECRET_LIKE_VALUE = /(?:sk-|ghp_|github_pat_|Bearer\s+|[A-Za-z0-9+/]{40,}={0,2})/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= maxLength
    && !value.includes('\0');
}

function validateReference(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): ConfigurationReference | null {
  if (!isRecord(value)) {
    issues.push({ path, reason: 'must be an object' });
    return null;
  }
  if (!hasOnlyKeys(value, ['id', 'label', 'source'])) {
    issues.push({ path, reason: 'has unknown fields' });
    return null;
  }
  if (!isBoundedString(value.id, 128) || !ID_PATTERN.test(value.id)) {
    issues.push({ path: `${path}.id`, reason: 'must be a bounded opaque identifier' });
    return null;
  }
  if (!isBoundedString(value.label, MAX_LABEL_LENGTH)) {
    issues.push({ path: `${path}.label`, reason: 'must be a bounded non-empty string' });
    return null;
  }
  if (typeof value.source !== 'string' || !SOURCES.includes(value.source as ConfigurationSource)) {
    issues.push({ path: `${path}.source`, reason: 'must be an accepted source' });
    return null;
  }
  if (SECRET_LIKE_KEY.test(value.id) || SECRET_LIKE_KEY.test(value.label)) {
    issues.push({ path, reason: 'must not embed a secret-like field' });
    return null;
  }
  if (SECRET_LIKE_VALUE.test(value.id) || SECRET_LIKE_VALUE.test(value.label)) {
    issues.push({ path, reason: 'must not contain a secret-like value' });
    return null;
  }
  if (/^[a-z]+:\/\//i.test(value.label)) {
    issues.push({ path: `${path}.label`, reason: 'absolute URLs are not accepted in this local slice' });
    return null;
  }
  if (value.source === 'env' && SECRET_LIKE_KEY.test(value.id)) {
    issues.push({ path, reason: 'environment secrets are not accepted in this local slice' });
    return null;
  }
  return Object.freeze({
    id: value.id,
    label: value.label,
    source: value.source as ConfigurationSource,
  });
}

function validateSection(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): readonly ConfigurationReference[] {
  if (!Array.isArray(value)) {
    issues.push({ path, reason: 'must be an array' });
    return [];
  }
  if (value.length > MAX_REFERENCES_PER_SECTION) {
    issues.push({ path, reason: `must contain at most ${MAX_REFERENCES_PER_SECTION} entries` });
  }
  const entries: ConfigurationReference[] = [];
  const ids = new Set<string>();
  value.forEach((entry, index) => {
    const reference = validateReference(entry, `${path}[${index}]`, issues);
    if (!reference) return;
    if (ids.has(reference.id)) {
      issues.push({ path: `${path}[${index}].id`, reason: 'must be unique within its section' });
      return;
    }
    ids.add(reference.id);
    entries.push(reference);
  });
  return Object.freeze(entries.sort((left, right) => left.id.localeCompare(right.id)));
}

function validateSecretRefs(value: unknown, issues: ValidationIssue[]): readonly string[] {
  if (!Array.isArray(value)) {
    issues.push({ path: 'secretRefs', reason: 'must be an array' });
    return [];
  }
  if (value.length > MAX_SECRET_REFS) {
    issues.push({ path: 'secretRefs', reason: `must contain at most ${MAX_SECRET_REFS} entries` });
  }
  const refs: string[] = [];
  value.forEach((entry, index) => {
    if (!isBoundedString(entry, MAX_SECRET_REF_LENGTH)) {
      issues.push({ path: `secretRefs[${index}]`, reason: 'must be a bounded opaque string' });
      return;
    }
    if (SECRET_LIKE_VALUE.test(entry)) {
      issues.push({ path: `secretRefs[${index}]`, reason: 'must not contain a secret value' });
      return;
    }
    refs.push(entry);
  });
  return Object.freeze([...new Set(refs)].sort());
}

function validateMetadata(
  value: unknown,
  issues: ValidationIssue[],
): Readonly<Record<string, string>> {
  if (!isRecord(value)) {
    issues.push({ path: 'metadata', reason: 'must be an object' });
    return {};
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_METADATA_ENTRIES) {
    issues.push({ path: 'metadata', reason: `must contain at most ${MAX_METADATA_ENTRIES} entries` });
  }
  const result: Record<string, string> = {};
  for (const [key, entryValue] of entries) {
    const path = `metadata.${key}`;
    if (!isBoundedString(key, MAX_METADATA_KEY_LENGTH) || !/^[a-z][a-z0-9_.-]{0,63}$/.test(key)) {
      issues.push({
        path,
        reason: SECRET_LIKE_KEY.test(key)
          ? 'must not contain a secret-like field or value'
          : 'key must be a bounded opaque identifier',
      });
      continue;
    }
    if (typeof entryValue !== 'string' || entryValue.length > MAX_METADATA_VALUE_LENGTH || entryValue.includes('\0')) {
      issues.push({ path, reason: 'value must be a bounded string' });
      continue;
    }
    if (SECRET_LIKE_KEY.test(key) || SECRET_LIKE_VALUE.test(entryValue)) {
      issues.push({ path, reason: 'must not contain a secret-like field or value' });
      continue;
    }
    result[key] = entryValue;
  }
  return Object.freeze(Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right))));
}

interface BaseConfiguration {
  readonly name: string | null;
  readonly sections: Pick<
    ConfigurationDocumentBase,
    'skills' | 'policies' | 'mcpServers' | 'plugins'
  >;
  readonly secretRefs: readonly string[];
  readonly metadata: Readonly<Record<string, string>>;
}

function parseBaseConfiguration(
  candidate: Record<string, unknown>,
  issues: ValidationIssue[],
): BaseConfiguration {
  const name = isBoundedString(candidate.name, MAX_NAME_LENGTH)
    ? candidate.name
    : null;
  if (name === null) {
    issues.push({ path: 'name', reason: 'must be a bounded non-empty string' });
  }
  const sections = Object.fromEntries(SECTIONS.map((section) => [
    section,
    validateSection(candidate[section], section, issues),
  ])) as unknown as BaseConfiguration['sections'];
  return {
    name,
    sections,
    secretRefs: validateSecretRefs(candidate.secretRefs, issues),
    metadata: validateMetadata(candidate.metadata, issues),
  };
}

function prefixCompositionIssues(error: CompositionValidationError): readonly ValidationIssue[] {
  return error.details.map((issue) => ({
    path: issue.path === '$' || issue.path.length === 0
      ? 'composition'
      : `composition.${issue.path}`,
    reason: issue.reason,
  }));
}

function parsePublicComposition(
  value: unknown,
  issues: ValidationIssue[],
): ConfigurationComposition | null {
  if (!isRecord(value)) {
    issues.push({ path: 'composition', reason: 'must be an object' });
    return null;
  }
  try {
    const parsed = parseCompositionDocument(value);
    return Object.freeze({
      schemaVersion: 1,
      name: parsed.name,
      nodes: parsed.nodes,
      links: parsed.links,
      entryNodeIds: parsed.entryNodeIds,
      metadata: parsed.metadata,
    });
  } catch (cause) {
    if (!(cause instanceof CompositionValidationError)) throw cause;
    issues.push(...prefixCompositionIssues(cause));
    return null;
  }
}

export function parseConfigurationDocument(input: unknown): ConfigurationDocument {
  let candidate = input;
  if (typeof candidate === 'string') {
    if (candidate.length > MAX_DOCUMENT_JSON_LENGTH) {
      throw new ConfigurationValidationError([
        { path: '$', reason: 'serialized document exceeds the accepted bound' },
      ]);
    }
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      throw new ConfigurationValidationError([{ path: '$', reason: 'must be valid JSON' }]);
    }
  }
  if (!isRecord(candidate)) {
    throw new ConfigurationValidationError([{ path: '$', reason: 'must be an object' }]);
  }
  if (candidate.schemaVersion !== 1 && candidate.schemaVersion !== 2) {
    throw new ConfigurationValidationError([
      { path: 'schemaVersion', reason: 'must be the accepted version 1 or 2' },
    ]);
  }
  const acceptedKeys = candidate.schemaVersion === 2 ? V2_KEYS : BASE_KEYS;
  if (!hasOnlyKeys(candidate, acceptedKeys)) {
    throw new ConfigurationValidationError([{ path: '$', reason: 'has unknown fields' }]);
  }

  const issues: ValidationIssue[] = [];
  const base = parseBaseConfiguration(candidate, issues);
  const composition = candidate.schemaVersion === 2
    ? parsePublicComposition(candidate.composition, issues)
    : null;
  if (base.name === null || issues.length > 0) {
    throw new ConfigurationValidationError(Object.freeze(issues));
  }

  if (candidate.schemaVersion === 2) {
    if (composition === null) {
      throw new ConfigurationValidationError([
        { path: 'composition', reason: 'must be a valid composition section' },
      ]);
    }
    return Object.freeze({
      schemaVersion: 2,
      name: base.name,
      ...base.sections,
      secretRefs: base.secretRefs,
      metadata: base.metadata,
      composition,
    });
  }

  return Object.freeze({
    schemaVersion: 1,
    name: base.name,
    ...base.sections,
    secretRefs: base.secretRefs,
    metadata: base.metadata,
  });
}

export function isConfigurationDocumentV2(
  document: ConfigurationDocument,
): document is ConfigurationDocumentV2 {
  return document.schemaVersion === 2;
}

function canonicalDocument(document: ConfigurationDocument): string {
  const base = {
    schemaVersion: document.schemaVersion,
    name: document.name,
    skills: document.skills,
    policies: document.policies,
    mcpServers: document.mcpServers,
    plugins: document.plugins,
    secretRefs: document.secretRefs,
    metadata: document.metadata,
  };
  return JSON.stringify(isConfigurationDocumentV2(document)
    ? { ...base, composition: document.composition }
    : base);
}

export function configurationRevisionId(document: ConfigurationDocument): ConfigurationRevisionId {
  const canonical = canonicalDocument(document);
  if (canonical.length > MAX_DOCUMENT_JSON_LENGTH) {
    throw new ConfigurationValidationError([
      { path: '$', reason: 'canonical document exceeds the accepted bound' },
    ]);
  }
  const versionPrefix = isConfigurationDocumentV2(document)
    ? 'conchbase-configuration-document-v2\0'
    : 'conchbase-configuration-document-v1\0';
  const hash = createHash('sha256')
    .update(versionPrefix)
    .update(canonical)
    .digest('hex')
    .slice(0, 24);
  return `cfg_${hash}` as ConfigurationRevisionId;
}

export function revisionSummary(revision: ConfigurationRevision): ConfigurationRevisionSummary {
  return Object.freeze({
    id: revision.id,
    name: revision.document.name,
    appliedAt: revision.appliedAt,
  });
}
