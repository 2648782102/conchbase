import assert from 'node:assert/strict';
import test from 'node:test';
import { chineseAgentDisplayName } from '../src/runtime/agent-name.js';

test('dynamic agent names are displayed in Chinese', () => {
  assert.equal(chineseAgentDisplayName('worker-validator'), '校验员');
  assert.equal(chineseAgentDisplayName('worker-scout'), '侦察员');
  assert.equal(chineseAgentDisplayName('worker-planner'), '规划员');
  assert.equal(chineseAgentDisplayName('worker-alpha'), '甲');
  assert.equal(chineseAgentDisplayName('项目助理'), '项目助理');
});
