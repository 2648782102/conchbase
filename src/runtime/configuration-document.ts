import { createHash } from 'node:crypto';

export type ConfigurationRevisionId = string & { readonly __brand: 'ConfigurationRevisionId' };
export type ConfigurationSource = 'inline' | 'file' | 'registry' | 'env';

export interface ConfigurationReference {
  readonly id: string;
  readonly label: string;
  readonly source: ConfigurationSource;
}

export interface ConfigurationDocument {
  readonly schemaVersion: 1;
  readonly name: string;
  readonly skills: readonly ConfigurationReference[];
  readonly policies: readonly ConfigurationReference[];
  readonly mcpServers: readonly ConfigurationReference[];
  readonly plugins: readonly ConfigurationReference[];
  readonly secretRefs: readonly string[];
  readonly metadata: Readonly<Record<string, string>>;
}

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
    this.details = details;
  }
}

export const BOOTSTRAP_CONFIGURATION_DOCUMENT: ConfigurationDocument = Object.freeze({
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
  const acceptedKeys = ['schemaVersion', 'name', ...SECTIONS, 'secretRefs', 'metadata'];
  if (!hasOnlyKeys(candidate, acceptedKeys)) {
    throw new ConfigurationValidationError([{ path: '$', reason: 'has unknown fields' }]);
  }
  if (candidate.schemaVersion !== 1) {
    throw new ConfigurationValidationError([
      { path: 'schemaVersion', reason: 'must be the accepted version 1' },
    ]);
  }
  if (!isBoundedString(candidate.name, MAX_NAME_LENGTH)) {
    throw new ConfigurationValidationError([
      { path: 'name', reason: 'must be a bounded non-empty string' },
    ]);
  }

  const issues: ValidationIssue[] = [];
  const sections = Object.fromEntries(SECTIONS.map((section) => [
    section,
    validateSection(candidate[section], section, issues),
  ])) as unknown as Pick<
    ConfigurationDocument,
    'skills' | 'policies' | 'mcpServers' | 'plugins'
  >;
  const secretRefs = validateSecretRefs(candidate.secretRefs, issues);
  const metadata = validateMetadata(candidate.metadata, issues);
  if (issues.length > 0) throw new ConfigurationValidationError(Object.freeze(issues));

  return Object.freeze({
    schemaVersion: 1,
    name: candidate.name,
    ...sections,
    secretRefs,
    metadata,
  });
}

function canonicalDocument(document: ConfigurationDocument): string {
  return JSON.stringify({
    schemaVersion: document.schemaVersion,
    name: document.name,
    skills: document.skills,
    policies: document.policies,
    mcpServers: document.mcpServers,
    plugins: document.plugins,
    secretRefs: document.secretRefs,
    metadata: document.metadata,
  });
}

export function configurationRevisionId(document: ConfigurationDocument): ConfigurationRevisionId {
  const canonical = canonicalDocument(document);
  if (canonical.length > MAX_DOCUMENT_JSON_LENGTH) {
    throw new ConfigurationValidationError([
      { path: '$', reason: 'canonical document exceeds the accepted bound' },
    ]);
  }
  const hash = createHash('sha256')
    .update('conchbase-configuration-document-v1\0')
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
