import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_CONTEXT_TOKENS,
  contextBudget,
  describeFit,
  estimatePromptTokens,
  estimateTokens,
  fitPrompt,
} from '../src/runtime/context-budget.js';
import type { ProviderMessage } from '../src/runtime/model-adapter.js';

test('tokens are estimated conservatively, and CJK is not undercounted', () => {
  assert.equal(estimateTokens(''), 0);
  // Four ASCII characters per token.
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2);
  // CJK is one token per character: a 100-character Chinese reply is not 25.
  assert.equal(estimateTokens('相'.repeat(100)), 100);
  // Mixed text adds both parts.
  assert.equal(estimateTokens('相'.repeat(10) + 'abcdefgh'), 12);
});

test('the budget always leaves room for a reply', () => {
  for (const total of [1_000, 8_000, 32_000, 128_000, 1_048_576]) {
    const budget = contextBudget(total);
    assert.equal(budget.totalTokens, total);
    assert.ok(budget.outputReserve >= 512, 'a reply always has room');
    assert.ok(budget.promptTokens < total, 'the prompt never consumes the whole window');
    assert.ok(budget.promptTokens >= 1);
  }
});

test('an unknown or absurd window falls back to the conservative default', () => {
  assert.equal(contextBudget(undefined).totalTokens, DEFAULT_CONTEXT_TOKENS);
  assert.equal(contextBudget(0).totalTokens, DEFAULT_CONTEXT_TOKENS);
  assert.equal(contextBudget(-1).totalTokens, DEFAULT_CONTEXT_TOKENS);
  assert.equal(contextBudget(Number.NaN).totalTokens, DEFAULT_CONTEXT_TOKENS);
});

test('a prompt inside the budget is returned untouched', () => {
  const messages: readonly ProviderMessage[] = [
    { role: 'system', content: 'instructions' },
    { role: 'user', content: 'hello' },
  ];
  const result = fitPrompt(messages, contextBudget(32_000));
  assert.equal(result.fit.kind, 'fits');
  assert.equal(result.messages, messages, 'no copy is made when nothing is dropped');
  assert.equal(describeFit(result.fit), null);
});

test('the oldest conversation is dropped first, and instructions survive', () => {
  const messages: readonly ProviderMessage[] = [
    { role: 'system', content: 'the Agent instructions' },
    ...Array.from({ length: 40 }, (_, index) => ({
      role: (index % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: 'x'.repeat(400),
    })),
  ];
  const budget = contextBudget(2_000);
  const result = fitPrompt(messages, budget);
  assert.equal(result.fit.kind, 'trimmed');
  assert.equal(result.messages[0]?.role, 'system', 'the instructions are never dropped');
  assert.equal(result.messages[0]?.content, 'the Agent instructions');
  assert.ok(result.messages.length < messages.length);
  assert.equal(result.messages[1]?.role, 'user', 'the kept tail opens on a question');
  assert.ok(estimatePromptTokens(result.messages) <= budget.promptTokens);
  assert.match(describeFit(result.fit) ?? '', /省略|dropped|${}/);
});

test('a tool result is never kept without the assistant turn that asked for it', () => {
  const filler = Array.from({ length: 30 }, (_, index) => ({
    role: (index % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: 'y'.repeat(300),
  }));
  const messages: readonly ProviderMessage[] = [
    { role: 'system', content: 'sys' },
    ...filler,
    { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'workspace_read', arguments: { path: 'a' } }] },
    { role: 'tool', toolCallId: 'call_1', content: 'file body' },
  ];
  const result = fitPrompt(messages, contextBudget(1_500));
  assert.equal(result.fit.kind, 'trimmed');
  // If the tool result survived, its call must have survived too.
  const keptTool = result.messages.find((message) => message.role === 'tool');
  if (keptTool) {
    const callIds = result.messages
      .filter((message) => message.role === 'assistant')
      .flatMap((message) => message.toolCalls?.map((call) => call.id) ?? []);
    assert.ok(callIds.includes('call_1'), 'a tool result without its call is a protocol error');
  }
});

test('instructions that cannot fit are reported, not silently truncated', () => {
  const messages: readonly ProviderMessage[] = [
    { role: 'system', content: 'z'.repeat(200_000) },
    { role: 'user', content: 'hi' },
  ];
  const result = fitPrompt(messages, contextBudget(1_000));
  assert.equal(result.fit.kind, 'overflow');
  assert.equal(result.messages, messages, 'an overflowing prompt is returned unchanged');
  assert.match(describeFit(result.fit) ?? '', /超出/);
});
