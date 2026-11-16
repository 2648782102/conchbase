import assert from 'node:assert/strict';
import test from 'node:test';
import { requiresApproval } from '../src/runtime/tool-gate.js';

test('restricted mode pauses writes and external calls', () => {
  assert.equal(requiresApproval('restricted', 'write'), true);
  assert.equal(requiresApproval('restricted', 'external'), true);
  assert.equal(requiresApproval('restricted', 'read'), false);
});

test('unrestricted mode executes without pausing', () => {
  // Scope is still enforced by grants; this only removes the human checkpoint.
  assert.equal(requiresApproval('unrestricted', 'write'), false);
  assert.equal(requiresApproval('unrestricted', 'external'), false);
  assert.equal(requiresApproval('unrestricted', 'read'), false);
});
