import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeBossReply } from '../src/runtime/organization-intent-parser.js';

test('keeps the line structure of a formatted reply', () => {
  const reply = ['### 一、目标', '- 写清交付物', '- 定验收标准', '', '### 二、拆解', '- 独立交付'].join('\n');
  assert.equal(normalizeBossReply(reply), reply);
});

test('keeps a fenced code block intact', () => {
  const reply = ['做法如下：', '```bash', 'echo hi', '```'].join('\n');
  assert.equal(normalizeBossReply(reply), reply);
});

test('collapses horizontal runs but not line breaks', () => {
  assert.equal(normalizeBossReply('a    b\n\n\n\nc'), 'a b\n\nc');
});

test('normalises CRLF', () => {
  assert.equal(normalizeBossReply('a\r\nb'), 'a\nb');
});

test('still strips other control characters', () => {
  const out = normalizeBossReply('a\u0000b\u001bc\u007fd');
  assert.equal(/[\u0000\u001b\u007f]/.test(out), false);
});

test('preserves indentation inside a code block', () => {
  const reply = ['```', '\tindented();', '```'].join('\n');
  assert.equal(normalizeBossReply(reply), reply);
});
