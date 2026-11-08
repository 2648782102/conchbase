import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CompositionValidationError,
  compositionDocumentId,
  parseCompositionDocument,
} from '../src/runtime/composition-document.js';

function baseDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    name: 'fixture composition',
    nodes: [{ id: 'node-a', label: 'First node' }],
    links: [],
    entryNodeIds: ['node-a'],
    metadata: { fixture: 'one' },
    ...overrides,
  };
}

function validationDetails(action: () => unknown): readonly { path: string; reason: string }[] {
  try {
    action();
    assert.fail('expected validation to fail');
  } catch (error) {
    assert.ok(error instanceof CompositionValidationError);
    return error.details;
  }
}

test('a single-node composition parses with a stable content-addressed id', () => {
  const document = parseCompositionDocument(baseDocument());
  assert.deepEqual(document.entryNodeIds, ['node-a']);
  assert.deepEqual(document.terminalNodeIds, ['node-a']);
  assert.deepEqual(document.links, []);
  assert.match(compositionDocumentId(document), /^cmp_[0-9a-f]{24}$/);
  assert.equal(
    compositionDocumentId(document),
    compositionDocumentId(parseCompositionDocument(baseDocument())),
  );
});

test('distinct multi-node shapes remain valid without canonical roles or layers', () => {
  const chain = parseCompositionDocument(baseDocument({
    nodes: [
      { id: 'node-c', label: 'Third node' },
      { id: 'node-a', label: 'First node' },
      { id: 'node-b', label: 'Second node' },
    ],
    links: [
      { id: 'link-a', from: 'node-a', to: 'node-b', label: 'first connection' },
      { id: 'link-b', from: 'node-b', to: 'node-c', label: 'second connection' },
    ],
    entryNodeIds: ['node-a'],
  }));
  assert.deepEqual(chain.entryNodeIds, ['node-a']);
  assert.deepEqual(chain.terminalNodeIds, ['node-c']);

  const diamond = parseCompositionDocument(baseDocument({
    nodes: [
      { id: 'source', label: 'Source node' },
      { id: 'left', label: 'Left node' },
      { id: 'right', label: 'Right node' },
      { id: 'sink', label: 'Sink node' },
    ],
    links: [
      { id: 'link-source-left', from: 'source', to: 'left', label: 'first branch' },
      { id: 'link-source-right', from: 'source', to: 'right', label: 'second branch' },
      { id: 'link-left-sink', from: 'left', to: 'sink', label: 'first merge' },
      { id: 'link-right-sink', from: 'right', to: 'sink', label: 'second merge' },
    ],
    entryNodeIds: ['source'],
  }));
  assert.deepEqual(diamond.terminalNodeIds, ['sink']);

  const multipleEntries = parseCompositionDocument(baseDocument({
    nodes: [
      { id: 'entry-a', label: 'First entry' },
      { id: 'entry-b', label: 'Second entry' },
      { id: 'join', label: 'Join node' },
    ],
    links: [
      { id: 'link-a', from: 'entry-a', to: 'join', label: 'first input' },
      { id: 'link-b', from: 'entry-b', to: 'join', label: 'second input' },
    ],
    entryNodeIds: ['entry-b', 'entry-a'],
  }));
  assert.deepEqual(multipleEntries.entryNodeIds, ['entry-a', 'entry-b']);
  assert.deepEqual(multipleEntries.terminalNodeIds, ['join']);
});

test('canonicalization sorts user-authored arrays without changing identity', () => {
  const first = parseCompositionDocument(baseDocument({
    nodes: [
      { id: 'node-b', label: 'Second node' },
      { id: 'node-a', label: 'First node' },
    ],
    links: [{ id: 'link-a', from: 'node-a', to: 'node-b', label: 'connection' }],
    entryNodeIds: ['node-a'],
    metadata: { z: 'last', a: 'first' },
  }));
  const reordered = parseCompositionDocument(baseDocument({
    nodes: [
      { id: 'node-a', label: 'First node' },
      { id: 'node-b', label: 'Second node' },
    ],
    links: [{ id: 'link-a', from: 'node-a', to: 'node-b', label: 'connection' }],
    entryNodeIds: ['node-a'],
    metadata: { a: 'first', z: 'last' },
  }));
  assert.equal(compositionDocumentId(first), compositionDocumentId(reordered));
});

test('malformed nodes, links, metadata, and unknown fields are rejected', () => {
  const duplicateNode = baseDocument({
    nodes: [
      { id: 'node-a', label: 'First node' },
      { id: 'node-a', label: 'Duplicate node' },
    ],
  });
  assert.ok(validationDetails(() => parseCompositionDocument(duplicateNode)).some(
    (issue) => issue.reason.includes('unique'),
  ));

  const unknownEndpoint = baseDocument({
    links: [{ id: 'link-a', from: 'node-a', to: 'missing', label: 'connection' }],
  });
  assert.ok(validationDetails(() => parseCompositionDocument(unknownEndpoint)).some(
    (issue) => issue.reason.includes('declared node'),
  ));

  const duplicatePair = baseDocument({
    nodes: [
      { id: 'node-a', label: 'First node' },
      { id: 'node-b', label: 'Second node' },
    ],
    links: [
      { id: 'link-a', from: 'node-a', to: 'node-b', label: 'first' },
      { id: 'link-b', from: 'node-a', to: 'node-b', label: 'second' },
    ],
  });
  assert.ok(validationDetails(() => parseCompositionDocument(duplicatePair)).some(
    (issue) => issue.reason.includes('duplicate links'),
  ));

  const missingMetadata = baseDocument();
  delete missingMetadata.metadata;
  assert.ok(validationDetails(() => parseCompositionDocument(missingMetadata)).some(
    (issue) => issue.path === 'metadata',
  ));

  const unknownField = baseDocument({ scheduling: 'sequential' });
  assert.ok(validationDetails(() => parseCompositionDocument(unknownField)).some(
    (issue) => issue.reason.includes('unknown fields'),
  ));

  const credentialLikeLabel = baseDocument({
    nodes: [{ id: 'node-a', label: 'apiKey holder' }],
  });
  assert.ok(validationDetails(() => parseCompositionDocument(credentialLikeLabel)).some(
    (issue) => issue.reason.includes('credential'),
  ));
});

test('entry sets, unreachable nodes, and cycles are rejected', () => {
  const wrongEntry = baseDocument({
    nodes: [
      { id: 'node-a', label: 'First node' },
      { id: 'node-b', label: 'Second node' },
    ],
    links: [{ id: 'link-a', from: 'node-a', to: 'node-b', label: 'connection' }],
    entryNodeIds: ['node-b'],
  });
  assert.ok(validationDetails(() => parseCompositionDocument(wrongEntry)).some(
    (issue) => issue.path === 'entryNodeIds',
  ));

  const unreachableCycle = baseDocument({
    nodes: [
      { id: 'node-a', label: 'First node' },
      { id: 'node-b', label: 'Second node' },
      { id: 'node-c', label: 'Third node' },
    ],
    links: [
      { id: 'link-b', from: 'node-b', to: 'node-c', label: 'forward' },
      { id: 'link-c', from: 'node-c', to: 'node-b', label: 'backward' },
    ],
    entryNodeIds: ['node-a'],
  });
  assert.ok(validationDetails(() => parseCompositionDocument(unreachableCycle)).some(
    (issue) => issue.reason.includes('cycle'),
  ));
});
