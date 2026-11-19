import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeProvider } from '../src/runtime/fake-provider.js';
import { ProviderError, type ProviderStreamEvent } from '../src/runtime/model-provider.js';

async function collect(iterable: AsyncIterable<ProviderStreamEvent>): Promise<ProviderStreamEvent[]> {
  const events: ProviderStreamEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

test('a text turn streams chunks then a final event', async () => {
  const provider = new FakeProvider({ turns: [{ kind: 'text', text: 'hello world' }] });
  const events = await collect(provider.streamTurn({ taskId: 't', messages: [] }));
  assert.ok(events.some((e) => e.kind === 'text'));
  const final = events.at(-1);
  assert.equal(final?.kind, 'final');
  assert.equal((final as { output: string }).output, 'hello world');
});

test('a tool-call turn yields the calls unchanged', async () => {
  const provider = new FakeProvider({
    turns: [{ kind: 'tool_calls', content: 'thinking', calls: [{ id: 'c1', name: 'workspace_list', arguments: { path: '.' } }] }],
  });
  const events = await collect(provider.streamTurn({ taskId: 't', messages: [] }));
  const callEvent = events.find((e) => e.kind === 'tool_calls');
  assert.ok(callEvent);
  assert.equal((callEvent as { calls: readonly { name: string }[] }).calls[0]?.name, 'workspace_list');
});

test('an error turn throws a categorized ProviderError', async () => {
  const provider = new FakeProvider({ turns: [{ kind: 'error', kindOf: 'rate-limit' }] });
  await assert.rejects(
    () => collect(provider.streamTurn({ taskId: 't', messages: [] })),
    (cause: unknown) => cause instanceof ProviderError && cause.kind === 'rate-limit' && cause.retryable,
  );
});

test('catalog is returned and stable', async () => {
  const provider = new FakeProvider({ turns: [{ kind: 'text', text: 'x' }] });
  const models = await provider.listModels();
  assert.equal(models[0]?.id, 'fake/model');
});

test('an already-aborted request does not consume a turn', async () => {
  const provider = new FakeProvider({ turns: [{ kind: 'text', text: 'x' }] });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => collect(provider.streamTurn({ taskId: 't', messages: [], signal: controller.signal })));
  assert.equal(provider.consumed, 0);
});
