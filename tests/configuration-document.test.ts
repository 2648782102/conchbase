import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BOOTSTRAP_CONFIGURATION_DOCUMENT,
  ConfigurationValidationError,
  configurationRevisionId,
  parseConfigurationDocument,
} from '../src/runtime/configuration-document.js';

function document(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    name: 'fixture profile',
    skills: [{ id: 'skill.fixture', label: 'Fixture skill', source: 'inline' }],
    policies: [],
    mcpServers: [],
    plugins: [],
    secretRefs: ['magpie-model'],
    metadata: { owner: 'fixture' },
  };
}

function validationDetails(action: () => unknown): readonly { path: string; reason: string }[] {
  try {
    action();
    assert.fail('expected validation to fail');
  } catch (error) {
    assert.ok(error instanceof ConfigurationValidationError);
    return error.details;
  }
}

test('bootstrap document parses and produces a stable content-addressed id', () => {
  const parsed = parseConfigurationDocument(BOOTSTRAP_CONFIGURATION_DOCUMENT);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.metadata.boundary, 'phase-1');
  assert.deepEqual(parsed.policies.map((entry) => entry.id), ['no-model-tool-execution']);
  assert.match(configurationRevisionId(parsed), /^cfg_[0-9a-f]{24}$/);
  assert.equal(
    configurationRevisionId(parsed),
    configurationRevisionId(parseConfigurationDocument(BOOTSTRAP_CONFIGURATION_DOCUMENT)),
  );
});

test('canonicalization sorts references and metadata without changing identity', () => {
  const first = document();
  const reordered = document();
  reordered.skills = [
    { id: 'skill.z', label: 'Z', source: 'file' },
    { id: 'skill.a', label: 'A', source: 'inline' },
  ];
  reordered.secretRefs = ['z-ref', 'a-ref'];
  reordered.metadata = { z: 'last', a: 'first' };
  const forward = parseConfigurationDocument(reordered);
  const reverse = parseConfigurationDocument({
    ...reordered,
    skills: [...(reordered.skills as unknown[])].reverse(),
    secretRefs: ['a-ref', 'z-ref'],
    metadata: { a: 'first', z: 'last' },
  });
  assert.equal(configurationRevisionId(forward), configurationRevisionId(reverse));
  assert.notEqual(configurationRevisionId(forward), configurationRevisionId(parseConfigurationDocument(first)));
});

test('unknown fields, duplicate ids, and secret-like values are rejected', () => {
  const withUnknown = document();
  withUnknown.composition = { layers: 3 };
  assert.match(validationDetails(() => parseConfigurationDocument(withUnknown))[0]!.reason, /unknown fields/);

  const duplicate = document();
  duplicate.skills = [
    { id: 'same', label: 'One', source: 'inline' },
    { id: 'same', label: 'Two', source: 'inline' },
  ];
  assert.ok(validationDetails(() => parseConfigurationDocument(duplicate)).some(
    (issue) => issue.reason.includes('unique'),
  ));

  const secret = document();
  secret.metadata = { apiKey: 'fixture' };
  assert.ok(validationDetails(() => parseConfigurationDocument(secret)).some(
    (issue) => issue.reason.includes('secret'),
  ));

  const credential = document();
  credential.secretRefs = ['sk-1234567890123456789012345678901234567890'];
  assert.ok(validationDetails(() => parseConfigurationDocument(credential)).some(
    (issue) => issue.reason.includes('secret value'),
  ));
});

test('unaccepted sources, absolute URL labels, and unsupported schema versions are rejected', () => {
  const url = document();
  url.mcpServers = [{ id: 'remote', label: 'Remote', source: 'url' }];
  assert.ok(validationDetails(() => parseConfigurationDocument(url)).some(
    (issue) => issue.reason.includes('accepted source'),
  ));

  const absoluteLabel = document();
  absoluteLabel.plugins = [{ id: 'plugin.fixture', label: 'https://example.test', source: 'file' }];
  assert.ok(validationDetails(() => parseConfigurationDocument(absoluteLabel)).some(
    (issue) => issue.reason.includes('absolute URLs'),
  ));

  const versioned = document();
  versioned.schemaVersion = 2;
  assert.match(validationDetails(() => parseConfigurationDocument(versioned))[0]!.path, /schemaVersion/);

  const missingSections = document();
  delete missingSections.plugins;
  assert.ok(validationDetails(() => parseConfigurationDocument(missingSections)).some(
    (issue) => issue.path === 'plugins',
  ));

  const missingMetadata = document();
  delete missingMetadata.metadata;
  assert.ok(validationDetails(() => parseConfigurationDocument(missingMetadata)).some(
    (issue) => issue.path === 'metadata',
  ));
});
