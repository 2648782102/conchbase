import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ProviderToolCallError,
  parseOpenAiChatCompletionsToolCall,
} from '../src/runtime/provider-tool-call.js';
import { toolArgumentsDigest } from '../src/runtime/tool-request.js';

function validToolCall(): Record<string, unknown> {
  return {
    id: 'call_1',
    type: 'function',
    function: {
      name: 'fixture_read',
      arguments: JSON.stringify({
        value: 'bounded',
        count: 2,
        enabled: true,
        optional: null,
      }),
    },
  };
}

function toolCallWith(
  callOverrides: Record<string, unknown> = {},
  functionOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const base = validToolCall();
  const baseFunction = base.function as Record<string, unknown>;
  return {
    ...base,
    ...callOverrides,
    function: { ...baseFunction, ...functionOverrides },
  };
}

function response(toolCalls: unknown, content: unknown = null): unknown {
  return {
    choices: [{ message: { content, tool_calls: toolCalls } }],
  };
}

function expectParserError(payload: unknown, label: string): void {
  assert.throws(
    () => parseOpenAiChatCompletionsToolCall(payload),
    (cause: unknown) => cause instanceof ProviderToolCallError && cause.details.length > 0,
    label,
  );
}

test('one non-streaming function tool call becomes a transient normalized observation', () => {
  const observation = parseOpenAiChatCompletionsToolCall(response([validToolCall()]));
  assert.ok(observation);
  assert.equal(observation.version, 1);
  assert.equal(observation.kind, 'tool_call');
  assert.equal(observation.provider, 'openai-chat-completions');
  assert.equal(observation.providerToolCallId, 'call_1');
  assert.deepEqual(observation.toolCall, {
    toolName: 'fixture_read',
    arguments: { value: 'bounded', count: 2, enabled: true, optional: null },
  });
  assert.equal(observation.argumentsDigest, toolArgumentsDigest(observation.toolCall.arguments));
  assert.equal(Object.isFrozen(observation), true);
  const serialized = JSON.stringify(observation);
  assert.doesNotMatch(serialized, /choices|tool_calls|function|taskId|compositionNodeId|approval|decision|tool\.executed/);
});

test('a final answer without tool_calls is not a parser observation', () => {
  assert.equal(
    parseOpenAiChatCompletionsToolCall({ choices: [{ message: { content: 'ok' } }] }),
    null,
  );
  assert.equal(
    parseOpenAiChatCompletionsToolCall(response(undefined, 'ok')),
    null,
  );
});

test('unsupported provider shapes are rejected with bounded validation issues', () => {
  const invalidPayloads: Array<{ label: string; payload: unknown }> = [
    { label: 'non-object payload', payload: null },
    { label: 'multiple choices', payload: { choices: [{ message: { content: 'ok' } }, { message: { content: 'ok' } }] } },
    { label: 'missing message', payload: { choices: [{}] } },
    { label: 'streaming delta', payload: { choices: [{ delta: { tool_calls: [validToolCall()] } }] } },
    { label: 'null tool calls', payload: response(null) },
    { label: 'empty tool calls', payload: response([]) },
    { label: 'multiple tool calls', payload: response([validToolCall(), validToolCall()]) },
    { label: 'mixed answer text', payload: response([validToolCall()], 'partial answer') },
    { label: 'non-string content', payload: response([validToolCall()], 42) },
    { label: 'unsupported type', payload: response([toolCallWith({ type: 'custom' })]) },
    { label: 'missing id', payload: response([toolCallWith({ id: undefined })]) },
    { label: 'sensitive id', payload: response([toolCallWith({ id: 'sk-not-a-real-credential' })]) },
    { label: 'oversized opaque id', payload: response([toolCallWith({ id: 'a'.repeat(129) })]) },
    { label: 'unknown call field', payload: response([toolCallWith({ index: 0 })]) },
    { label: 'unknown function field', payload: response([toolCallWith({}, { extra: true })]) },
    { label: 'non-string arguments', payload: response([toolCallWith({}, { arguments: {} })]) },
    { label: 'oversized arguments', payload: response([toolCallWith({}, { arguments: 'x'.repeat(8001) })]) },
    { label: 'invalid arguments JSON', payload: response([toolCallWith({}, { arguments: '{invalid' })]) },
    { label: 'array arguments', payload: response([toolCallWith({}, { arguments: '[]' })]) },
    { label: 'null arguments', payload: response([toolCallWith({}, { arguments: 'null' })]) },
    { label: 'nested arguments', payload: response([toolCallWith({}, { arguments: JSON.stringify({ nested: { value: 'x' } }) })]) },
    { label: 'secret-like key', payload: response([toolCallWith({}, { arguments: JSON.stringify({ api_key: 'bounded' }) })]) },
    { label: 'secret-like value', payload: response([toolCallWith({}, { arguments: JSON.stringify({ value: 'sk-not-a-real-credential' }) })]) },
    { label: 'absolute URL value', payload: response([toolCallWith({}, { arguments: JSON.stringify({ value: 'https://example.com' }) })]) },
    { label: 'invalid tool name', payload: response([toolCallWith({}, { name: 'Fixture-Read' })]) },
  ];
  for (const item of invalidPayloads) expectParserError(item.payload, item.label);
});
