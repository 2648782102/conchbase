import { createHash } from 'node:crypto';

export type CompositionDocumentId = string & { readonly __brand: 'CompositionDocumentId' };

export interface CompositionNode {
  readonly id: string;
  readonly label: string;
}

export interface CompositionLink {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly label: string;
}

export interface CompositionDocument {
  readonly schemaVersion: 1;
  readonly name: string;
  readonly nodes: readonly CompositionNode[];
  readonly links: readonly CompositionLink[];
  readonly entryNodeIds: readonly string[];
  readonly terminalNodeIds: readonly string[];
  readonly metadata: Readonly<Record<string, string>>;
}

export interface CompositionValidationIssue {
  readonly path: string;
  readonly reason: string;
}

export class CompositionValidationError extends Error {
  readonly details: readonly CompositionValidationIssue[];

  constructor(details: readonly CompositionValidationIssue[]) {
    super('Composition document does not match the internal identity contract.');
    this.name = 'CompositionValidationError';
    this.details = Object.freeze([...details]);
  }
}

const ID_PATTERN = /^[a-z][a-z0-9_.-]{0,127}$/;
const METADATA_KEY_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
const ABSOLUTE_URL = /^[a-z]+:\/\//i;
const SECRET_LIKE_KEY = /\b(?:api[_-]?key|access[_-]?token|token|password|secret|credential|private[_-]?key)\b/i;
const SECRET_LIKE_VALUE = /(?:sk-|ghp_|github_pat_|Bearer\s+|[A-Za-z0-9+/]{40,}={0,2})/i;
const MAX_NODES = 64;
const MAX_LINKS = 256;
const MAX_NAME_LENGTH = 120;
const MAX_LABEL_LENGTH = 200;
const MAX_METADATA_ENTRIES = 32;
const MAX_METADATA_KEY_LENGTH = 64;
const MAX_METADATA_VALUE_LENGTH = 500;
const MAX_DOCUMENT_JSON_LENGTH = 20_000;

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

function validateIdentifier(
  value: unknown,
  path: string,
  issues: CompositionValidationIssue[],
): string | null {
  if (!isBoundedString(value, 128) || !ID_PATTERN.test(value)) {
    issues.push({ path, reason: 'must be a bounded opaque identifier' });
    return null;
  }
  if (SECRET_LIKE_KEY.test(value) || SECRET_LIKE_VALUE.test(value) || ABSOLUTE_URL.test(value)) {
    issues.push({ path, reason: 'must not contain a credential, secret value, or absolute URL' });
    return null;
  }
  return value;
}

function validateLabel(
  value: unknown,
  path: string,
  issues: CompositionValidationIssue[],
): string | null {
  if (!isBoundedString(value, MAX_LABEL_LENGTH)) {
    issues.push({ path, reason: 'must be a bounded non-empty string' });
    return null;
  }
  if (SECRET_LIKE_KEY.test(value) || SECRET_LIKE_VALUE.test(value) || ABSOLUTE_URL.test(value)) {
    issues.push({ path, reason: 'must not contain a credential, secret value, or absolute URL' });
    return null;
  }
  return value;
}

function validateName(
  value: unknown,
  issues: CompositionValidationIssue[],
): string | null {
  if (!isBoundedString(value, MAX_NAME_LENGTH)) {
    issues.push({ path: 'name', reason: 'must be a bounded non-empty string' });
    return null;
  }
  if (SECRET_LIKE_KEY.test(value) || SECRET_LIKE_VALUE.test(value) || ABSOLUTE_URL.test(value)) {
    issues.push({ path: 'name', reason: 'must not contain a credential, secret value, or absolute URL' });
    return null;
  }
  return value;
}

function parseNodes(
  value: unknown,
  issues: CompositionValidationIssue[],
): readonly CompositionNode[] {
  if (!Array.isArray(value)) {
    issues.push({ path: 'nodes', reason: 'must be an array' });
    return [];
  }
  if (value.length === 0 || value.length > MAX_NODES) {
    issues.push({ path: 'nodes', reason: `must contain between 1 and ${MAX_NODES} entries` });
  }
  const nodes: CompositionNode[] = [];
  const nodeIds = new Set<string>();
  value.forEach((entry, index) => {
    const path = `nodes[${index}]`;
    if (!isRecord(entry)) {
      issues.push({ path, reason: 'must be an object' });
      return;
    }
    if (!hasOnlyKeys(entry, ['id', 'label'])) {
      issues.push({ path, reason: 'has unknown fields' });
      return;
    }
    const id = validateIdentifier(entry.id, `${path}.id`, issues);
    const label = validateLabel(entry.label, `${path}.label`, issues);
    if (id === null || label === null) return;
    if (nodeIds.has(id)) {
      issues.push({ path: `${path}.id`, reason: 'must be unique' });
      return;
    }
    nodeIds.add(id);
    nodes.push(Object.freeze({ id, label }));
  });
  return Object.freeze(nodes.sort((left, right) => left.id.localeCompare(right.id)));
}

function parseLinks(
  value: unknown,
  nodeIds: ReadonlySet<string>,
  issues: CompositionValidationIssue[],
): readonly CompositionLink[] {
  if (!Array.isArray(value)) {
    issues.push({ path: 'links', reason: 'must be an array' });
    return [];
  }
  if (value.length > MAX_LINKS) {
    issues.push({ path: 'links', reason: `must contain at most ${MAX_LINKS} entries` });
  }
  const links: CompositionLink[] = [];
  const linkIds = new Set<string>();
  const nodePairs = new Set<string>();
  value.forEach((entry, index) => {
    const path = `links[${index}]`;
    if (!isRecord(entry)) {
      issues.push({ path, reason: 'must be an object' });
      return;
    }
    if (!hasOnlyKeys(entry, ['id', 'from', 'to', 'label'])) {
      issues.push({ path, reason: 'has unknown fields' });
      return;
    }
    const id = validateIdentifier(entry.id, `${path}.id`, issues);
    const from = validateIdentifier(entry.from, `${path}.from`, issues);
    const to = validateIdentifier(entry.to, `${path}.to`, issues);
    const label = validateLabel(entry.label, `${path}.label`, issues);
    if (id === null || from === null || to === null || label === null) return;
    if (!nodeIds.has(from)) {
      issues.push({ path: `${path}.from`, reason: 'must reference a declared node' });
      return;
    }
    if (!nodeIds.has(to)) {
      issues.push({ path: `${path}.to`, reason: 'must reference a declared node' });
      return;
    }
    if (from === to) {
      issues.push({ path: `${path}.to`, reason: 'must not connect a node to itself' });
      return;
    }
    if (linkIds.has(id)) {
      issues.push({ path: `${path}.id`, reason: 'must be unique' });
      return;
    }
    const nodePair = `${from}\0${to}`;
    if (nodePairs.has(nodePair)) {
      issues.push({ path, reason: 'duplicate links between the same nodes are not accepted' });
      return;
    }
    linkIds.add(id);
    nodePairs.add(nodePair);
    links.push(Object.freeze({ id, from, to, label }));
  });
  return Object.freeze(links.sort((left, right) => left.id.localeCompare(right.id)));
}

function parseEntryNodeIds(
  value: unknown,
  nodeIds: ReadonlySet<string>,
  issues: CompositionValidationIssue[],
): readonly string[] {
  if (!Array.isArray(value)) {
    issues.push({ path: 'entryNodeIds', reason: 'must be an array' });
    return [];
  }
  if (value.length === 0 || value.length > MAX_NODES) {
    issues.push({ path: 'entryNodeIds', reason: `must contain between 1 and ${MAX_NODES} entries` });
  }
  const entryNodeIds: string[] = [];
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    const path = `entryNodeIds[${index}]`;
    const id = validateIdentifier(entry, path, issues);
    if (id === null) return;
    if (!nodeIds.has(id)) {
      issues.push({ path, reason: 'must reference a declared node' });
      return;
    }
    if (seen.has(id)) {
      issues.push({ path, reason: 'must be unique' });
      return;
    }
    seen.add(id);
    entryNodeIds.push(id);
  });
  return Object.freeze([...entryNodeIds].sort());
}

function parseMetadata(
  value: unknown,
  issues: CompositionValidationIssue[],
): Readonly<Record<string, string>> {
  if (!isRecord(value)) {
    issues.push({ path: 'metadata', reason: 'must be an object' });
    return Object.freeze({});
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_METADATA_ENTRIES) {
    issues.push({ path: 'metadata', reason: `must contain at most ${MAX_METADATA_ENTRIES} entries` });
  }
  const result: Record<string, string> = {};
  for (const [key, entryValue] of entries) {
    const path = `metadata.${key}`;
    if (!isBoundedString(key, MAX_METADATA_KEY_LENGTH) || !METADATA_KEY_PATTERN.test(key)) {
      issues.push({ path, reason: 'key must be a bounded opaque identifier' });
      continue;
    }
    if (typeof entryValue !== 'string' || entryValue.length > MAX_METADATA_VALUE_LENGTH || entryValue.includes('\0')) {
      issues.push({ path, reason: 'value must be a bounded string' });
      continue;
    }
    if (SECRET_LIKE_KEY.test(key) || SECRET_LIKE_VALUE.test(entryValue) || ABSOLUTE_URL.test(entryValue)) {
      issues.push({ path, reason: 'must not contain a credential, secret value, or absolute URL' });
      continue;
    }
    result[key] = entryValue;
  }
  return Object.freeze(Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right))));
}

function computeTerminalNodeIds(
  nodeIds: readonly string[],
  links: readonly CompositionLink[],
): readonly string[] {
  const sourceIds = new Set(links.map((link) => link.from));
  return Object.freeze(nodeIds.filter((id) => !sourceIds.has(id)).sort());
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateGraph(
  nodes: readonly CompositionNode[],
  links: readonly CompositionLink[],
  entryNodeIds: readonly string[],
  issues: CompositionValidationIssue[],
): void {
  const nodeIds = nodes.map((node) => node.id);
  const incomingCount = new Map(nodeIds.map((id) => [id, 0]));
  const outgoingTargets = new Map(nodeIds.map((id) => [id, [] as string[]]));
  for (const link of links) {
    incomingCount.set(link.to, (incomingCount.get(link.to) ?? 0) + 1);
    outgoingTargets.get(link.from)?.push(link.to);
  }

  const rootIds = nodeIds.filter((id) => incomingCount.get(id) === 0).sort();
  if (!sameStringArray(rootIds, [...entryNodeIds].sort())) {
    issues.push({ path: 'entryNodeIds', reason: 'must list exactly the nodes without incoming links' });
  }

  const remainingIncoming = new Map(incomingCount);
  const queue = [...entryNodeIds].sort();
  const visited = new Set<string>();
  while (queue.length > 0) {
    const nodeId = queue.shift();
    if (nodeId === undefined || visited.has(nodeId)) continue;
    visited.add(nodeId);
    for (const target of outgoingTargets.get(nodeId) ?? []) {
      const count = (remainingIncoming.get(target) ?? 0) - 1;
      remainingIncoming.set(target, count);
      if (count === 0) queue.push(target);
    }
  }
  if (visited.size !== nodeIds.length) {
    for (const nodeId of nodeIds) {
      if (!visited.has(nodeId)) {
        issues.push({
          path: `nodes.${nodeId}`,
          reason: 'must be reachable from an entry node without a cycle',
        });
      }
    }
  }
}

function canonicalDocument(document: CompositionDocument): string {
  return JSON.stringify({
    schemaVersion: document.schemaVersion,
    name: document.name,
    nodes: document.nodes,
    links: document.links,
    entryNodeIds: document.entryNodeIds,
    terminalNodeIds: document.terminalNodeIds,
    metadata: document.metadata,
  });
}

export function parseCompositionDocument(input: unknown): CompositionDocument {
  let candidate = input;
  if (typeof candidate === 'string') {
    if (candidate.length > MAX_DOCUMENT_JSON_LENGTH) {
      throw new CompositionValidationError([
        { path: '$', reason: 'serialized document exceeds the accepted bound' },
      ]);
    }
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      throw new CompositionValidationError([{ path: '$', reason: 'must be valid JSON' }]);
    }
  }
  if (!isRecord(candidate)) {
    throw new CompositionValidationError([{ path: '$', reason: 'must be an object' }]);
  }
  const acceptedKeys = ['schemaVersion', 'name', 'nodes', 'links', 'entryNodeIds', 'metadata'];
  if (!hasOnlyKeys(candidate, acceptedKeys)) {
    throw new CompositionValidationError([{ path: '$', reason: 'has unknown fields' }]);
  }
  if (candidate.schemaVersion !== 1) {
    throw new CompositionValidationError([
      { path: 'schemaVersion', reason: 'must be the accepted version 1' },
    ]);
  }

  const issues: CompositionValidationIssue[] = [];
  const name = validateName(candidate.name, issues);
  const nodes = parseNodes(candidate.nodes, issues);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const links = parseLinks(candidate.links, nodeIds, issues);
  const entryNodeIds = parseEntryNodeIds(candidate.entryNodeIds, nodeIds, issues);
  const metadata = parseMetadata(candidate.metadata, issues);
  if (name === null) throw new CompositionValidationError(issues);
  if (issues.length === 0) validateGraph(nodes, links, entryNodeIds, issues);
  if (issues.length > 0) throw new CompositionValidationError(issues);

  const document = Object.freeze({
    schemaVersion: 1,
    name,
    nodes,
    links,
    entryNodeIds,
    terminalNodeIds: computeTerminalNodeIds(nodes.map((node) => node.id), links),
    metadata,
  });
  if (canonicalDocument(document).length > MAX_DOCUMENT_JSON_LENGTH) {
    throw new CompositionValidationError([
      { path: '$', reason: 'canonical document exceeds the accepted bound' },
    ]);
  }
  return document;
}

export function compositionDocumentId(document: CompositionDocument): CompositionDocumentId {
  const canonical = canonicalDocument(document);
  if (canonical.length > MAX_DOCUMENT_JSON_LENGTH) {
    throw new CompositionValidationError([
      { path: '$', reason: 'canonical document exceeds the accepted bound' },
    ]);
  }
  const hash = createHash('sha256')
    .update('conchbase-composition-document-v1\0')
    .update(canonical)
    .digest('hex')
    .slice(0, 24);
  return `cmp_${hash}` as CompositionDocumentId;
}
