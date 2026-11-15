import assert from 'node:assert/strict';
import test from 'node:test';
import { AG_UI_EVENT_TYPES, agUiEventType } from '../src/runtime/ag-ui-events.js';

test('snapshots map to STATE_SNAPSHOT and health has no AG-UI equivalent', () => {
  assert.equal(agUiEventType({ kind: 'snapshot' }), AG_UI_EVENT_TYPES.stateSnapshot);
  assert.equal(agUiEventType({ kind: 'health' }), null);
});

test('a user message starts a text message', () => {
  assert.equal(
    agUiEventType({ kind: 'message', author: 'user', messageState: 'published' }),
    AG_UI_EVENT_TYPES.textMessageStart,
  );
});

test('assistant progress maps to content, and terminal states to an end event', () => {
  for (const state of ['thinking', 'streaming', 'organizing']) {
    assert.equal(
      agUiEventType({ kind: 'message', author: 'assistant', messageState: state }),
      AG_UI_EVENT_TYPES.textMessageContent,
      state,
    );
  }
  for (const state of ['succeeded', 'replied']) {
    assert.equal(
      agUiEventType({ kind: 'message', author: 'assistant', messageState: state }),
      AG_UI_EVENT_TYPES.textMessageEnd,
      state,
    );
  }
});

test('approval waits are CUSTOM rather than a misleading tool event', () => {
  for (const state of ['waiting_approval', 'waiting_attention']) {
    assert.equal(
      agUiEventType({ kind: 'message', author: 'assistant', messageState: state }),
      AG_UI_EVENT_TYPES.custom,
      state,
    );
  }
});

test('failures map to RUN_ERROR', () => {
  for (const state of ['failed', 'unavailable', 'cancelled']) {
    assert.equal(
      agUiEventType({ kind: 'message', author: 'assistant', messageState: state }),
      AG_UI_EVENT_TYPES.runError,
      state,
    );
  }
});

test('every mapped type is part of the published AG-UI vocabulary', () => {
  const vocabulary = new Set<string>(Object.values(AG_UI_EVENT_TYPES));
  for (const state of [
    'published', 'pending', 'succeeded', 'failed', 'cancelled', 'thinking',
    'streaming', 'organizing', 'waiting_approval', 'waiting_attention', 'replied', 'unavailable',
  ]) {
    const mapped = agUiEventType({ kind: 'message', author: 'assistant', messageState: state });
    assert.ok(mapped === null || vocabulary.has(mapped), `${state} -> ${mapped}`);
  }
});
