import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultWorkerGrants } from '../src/runtime/capability-grants.js';
import { createBuiltinReadTools } from '../src/runtime/tool-provider.js';

test('dynamically hired workers inherit web extraction only when the runtime registered it', () => {
  const readOnly = createBuiltinReadTools({ root: process.cwd() });
  const withoutWeb = defaultWorkerGrants(readOnly, []);
  assert.equal(withoutWeb.some((grant) => grant.name === 'web_extract'), false);

  const withWeb = {
    ...readOnly,
    list: () => Object.freeze([...readOnly.list(), {
      id: 'web_extract', version: 1 as const, description: 'x', sideEffect: 'external' as const,
    }]),
  };
  const grants = defaultWorkerGrants(withWeb, []);
  assert.equal(grants.some((grant) => grant.name === 'web_extract'), true);
});
