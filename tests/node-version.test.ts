import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MINIMUM_NODE_MAJOR,
  describeNodeRequirement,
  parseNodeMajor,
  checkNodeVersion,
} from '../src/runtime/node-version.js';

test('the minimum supported Node major is 24', () => {
  assert.equal(MINIMUM_NODE_MAJOR, 24);
});

test('parseNodeMajor reads the major from process.versions style strings', () => {
  assert.equal(parseNodeMajor('24.22.2'), 24);
  assert.equal(parseNodeMajor('v24.1.0'), 24);
  assert.equal(parseNodeMajor('22.11.0'), 22);
  assert.equal(parseNodeMajor(''), null);
  assert.equal(parseNodeMajor('not-a-version'), null);
});

test('checkNodeVersion accepts a supported runtime and carries the major', () => {
  const ok = checkNodeVersion('24.0.0');
  assert.equal(ok.ok, true);
  assert.equal(ok.major, 24);
  assert.equal(ok.required, 24);
});

test('checkNodeVersion rejects an older runtime with an actionable message', () => {
  const bad = checkNodeVersion('22.11.0');
  assert.equal(bad.ok, false);
  assert.equal(bad.major, 22);
  assert.match(bad.message, /Node\.js 24/);
  assert.match(bad.message, /22\.11\.0/);
});

test('checkNodeVersion rejects an unparseable version instead of passing it', () => {
  const unknown = checkNodeVersion('unknown');
  assert.equal(unknown.ok, false);
  assert.equal(unknown.major, null);
  assert.match(unknown.message, /could not determine/i);
});

test('the requirement description names the minimum major', () => {
  assert.match(describeNodeRequirement(), /Node\.js 24/);
});

test('package engines and .nvmrc agree with the runtime gate', async () => {
  const { readFileSync } = await import('node:fs');
  const path = await import('node:path');
  const root = path.join(import.meta.dirname, '..');
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    engines?: { node?: string };
  };
  assert.match(String(pkg.engines?.node), new RegExp(`>=${MINIMUM_NODE_MAJOR}`));
  const nvmrc = readFileSync(path.join(root, '.nvmrc'), 'utf8').trim();
  assert.equal(parseNodeMajor(`${nvmrc}.0.0`), MINIMUM_NODE_MAJOR);
});
