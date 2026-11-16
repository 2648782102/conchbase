import assert from 'node:assert/strict';
import test from 'node:test';
import { boundedOutput } from '../src/runtime/agent-chat-output.js';

test('keeps the line structure of a marked-up answer', () => {
  const body = ['## 标题', '', '1. 甲', '2. 乙', '', '```bash', 'echo hi', '```'].join('\n');
  assert.equal(boundedOutput(body), body);
});

test('normalises CRLF and a lone CR to a line feed', () => {
  assert.equal(boundedOutput('a\r\nb\rc'), 'a\nb\nc');
});

test('still strips control characters that are not line breaks', () => {
  const body = 'a\u0000b\u001bc\u007fd';
  const out = boundedOutput(body);
  assert.equal(out.includes('\u0000'), false);
  assert.equal(out.includes('\u001b'), false);
  assert.equal(out.includes('\u007f'), false);
});

test('keeps tabs, which carry indentation in code', () => {
  assert.equal(boundedOutput('```\n\tindented\n```'), '```\n\tindented\n```');
});

test('falls back for an empty answer', () => {
  assert.equal(boundedOutput(''), '模型未返回内容。');
  assert.equal(boundedOutput(null), '模型未返回内容。');
});

test('bounds the published body', () => {
  const out = boundedOutput('x'.repeat(20_000));
  assert.equal(out.length, 12_000);
});
