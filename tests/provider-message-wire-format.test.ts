import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenAiChatCompletionsProvider } from '../src/runtime/magpie-provider.js';
import type { ProviderMessage } from '../src/runtime/model-adapter.js';

function capturingProvider() {
  const captured: { body?: Record<string, unknown> } = {};
  const provider = new OpenAiChatCompletionsProvider({
    baseUrl: 'http://127.0.0.1:3425',
    model: 'fixture/model',
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured.body = JSON.parse(String(init?.body));
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    }) as typeof globalThis.fetch,
  });
  return { provider, captured };
}

async function send(messages: readonly ProviderMessage[]): Promise<Record<string, unknown>[]> {
  const { provider, captured } = capturingProvider();
  await provider.streamTurn({
    taskId: 'task_fixture',
    prompt: 'go',
    turnIndex: 1,
    messages,
    onOutputDelta: () => undefined,
  });
  return captured.body!.messages as Record<string, unknown>[];
}

test('a tool result is sent as tool_call_id, not the internal toolCallId', async () => {
  const messages = await send([
    { role: 'user', content: 'read it' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'workspace_read', arguments: { path: 'a.txt' } }] },
    { role: 'tool', toolCallId: 'call_1', content: 'alpha' },
  ]);
  const toolMessage = messages[2]!;
  assert.equal(toolMessage.role, 'tool');
  assert.equal(toolMessage.tool_call_id, 'call_1');
  assert.equal(toolMessage.content, 'alpha');
  assert.equal(toolMessage.toolCallId, undefined, 'the internal name must not leak onto the wire');
});

test('assistant tool calls become typed function calls with string arguments', async () => {
  const messages = await send([
    { role: 'assistant', content: '', toolCalls: [
      { id: 'call_1', name: 'workspace_read', arguments: { path: 'a.txt', offset: 10 } },
    ] },
    { role: 'tool', toolCallId: 'call_1', content: 'alpha' },
  ]);
  const assistant = messages[0]!;
  assert.equal(assistant.role, 'assistant');
  const calls = assistant.tool_calls as Record<string, unknown>[];
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.id, 'call_1');
  assert.equal(calls[0]!.type, 'function');
  const fn = calls[0]!.function as Record<string, unknown>;
  assert.equal(fn.name, 'workspace_read');
  assert.equal(typeof fn.arguments, 'string');
  assert.deepEqual(JSON.parse(String(fn.arguments)), { path: 'a.txt', offset: 10 });
  assert.equal(assistant.toolCalls, undefined, 'the internal name must not leak onto the wire');
});

test('plain messages are forwarded without tool fields', async () => {
  const messages = await send([
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'hello' },
  ]);
  assert.deepEqual(messages, [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'hello' },
  ]);
});
