import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTaskService } from '../src/runtime/task-service.js';
import { AgentChatService } from '../src/runtime/agent-chat.js';

/**
 * An accepted attachment must actually reach the model.
 *
 * Validating at the edge and then dropping the bytes would be the worst of both
 * worlds: the request succeeds, the user believes the image was sent, and the
 * model answers about nothing.
 */
test('an image attachment arrives at the provider as a content part', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-attach-runtime-'));
  let seenBody: Record<string, unknown> | null = null;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/v1/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'fixture/chat-model' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    seenBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    return new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: '看到了' }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  }) as typeof globalThis.fetch;

  const service = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture/chat-model',
    fetch: fetchImpl,
  });
  const chat = new AgentChatService(service);
  try {
    const agent = await service.createAgent({
      name: '看图员', instructions: '', providerId: 'magpie', modelId: 'fixture/chat-model',
    });
    const conversation = await chat.createConversation({ agentId: agent.id });
    await chat.postMessage(conversation.id, {
      text: '这张图里是什么？',
      idempotencyKey: 'img1',
      attachments: [{ kind: 'image', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }],
    });
    for (let tick = 0; tick < 300; tick += 1) {
      if (chat.view(conversation.id).messages[1]?.state === 'replied') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const messages = (seenBody as { messages?: readonly Record<string, unknown>[] } | null)?.messages ?? [];
    const userTurn = [...messages].reverse().find((message) => message.role === 'user');
    assert.ok(userTurn, 'the provider received a user turn');
    const content = userTurn!.content;
    assert.ok(Array.isArray(content), 'images make the content a part array');
    const parts = content as readonly { type: string; image_url?: { url?: string } }[];
    assert.ok(parts.some((part) => part.type === 'text'), 'the question is still there');
    const image = parts.find((part) => part.type === 'image_url');
    assert.ok(image, 'the image part is present');
    assert.match(String(image!.image_url?.url ?? ''), /^data:image\/png;base64,/);
  } finally {
    chat.close();
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an attachment is refused while a reply is still in flight', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conchbase-attach-busy-'));
  const gate: { release: (() => void) | null } = { release: null };
  let enteredResolve: (() => void) | null = null;
  const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
  const fetchImpl = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/v1/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'fixture/chat-model' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    enteredResolve?.();
    await new Promise<void>((done) => { gate.release = done; });
    return new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  }) as typeof globalThis.fetch;

  const service = createTaskService(path.join(directory, 'runtime.sqlite'), {
    magpieBaseUrl: 'http://127.0.0.1:3425',
    defaultModel: 'fixture/chat-model',
    fetch: fetchImpl,
  });
  const chat = new AgentChatService(service);
  try {
    const agent = await service.createAgent({
      name: '忙线', instructions: '', providerId: 'magpie', modelId: 'fixture/chat-model',
    });
    const conversation = await chat.createConversation({ agentId: agent.id });
    await chat.postMessage(conversation.id, { text: '第一个问题', idempotencyKey: 'a1' });
    await entered;

    /*
     * The queue stores text only. Accepting the image here would upload it and
     * then lose it, so the request is refused while the earlier turn runs.
     */
    await assert.rejects(
      chat.postMessage(conversation.id, {
        text: '第二个问题',
        idempotencyKey: 'a2',
        attachments: [{ kind: 'image', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }],
      }),
      /图片/,
    );
  } finally {
    gate.release?.();
    chat.close();
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
