import assert from 'node:assert/strict';
import test from 'node:test';
import {
  nonterminalMessageState,
  parseReasoningEffort,
  phaseForState,
  taskStateToMessageState,
  terminalTaskState,
  unavailableBody,
  unavailableError,
} from '../src/runtime/agent-chat-state.js';
import type { TaskSnapshot } from '../src/runtime/task-store.js';

const task = (over: Partial<TaskSnapshot>) => ({ id: 't', attempt: 1, ...over } as TaskSnapshot);

test('a successful task is done until read', () => {
  // The whole done/replied distinction lives here; mapping success to replied
  // would silently remove it.
  assert.equal(taskStateToMessageState(task({ state: 'succeeded' })), 'done');
});

test('terminal task states map to terminal message states', () => {
  assert.equal(taskStateToMessageState(task({ state: 'failed' })), 'failed');
  assert.equal(taskStateToMessageState(task({ state: 'cancelled' })), 'cancelled');
  assert.equal(taskStateToMessageState(task({ state: 'interrupted' })), 'failed');
  assert.equal(taskStateToMessageState(task({ state: 'waiting_approval' })), 'waiting_approval');
});

test('an unfinished task is streaming only when it has partial output', () => {
  assert.equal(taskStateToMessageState(task({ state: 'running', partialOutput: 'half' })), 'streaming');
  assert.equal(taskStateToMessageState(task({ state: 'running', partialOutput: null })), 'thinking');
  assert.equal(taskStateToMessageState(task({ state: 'queued' })), 'thinking');
});

test('terminality is only the four settled task states', () => {
  for (const state of ['succeeded', 'failed', 'cancelled', 'interrupted'] as const) {
    assert.equal(terminalTaskState(state), true, state);
  }
  for (const state of ['queued', 'running', 'waiting_approval'] as const) {
    assert.equal(terminalTaskState(state), false, state);
  }
});

test('phases group states for clients that only need coarse progress', () => {
  assert.equal(phaseForState('thinking'), 'preparing');
  assert.equal(phaseForState('streaming'), 'preparing');
  assert.equal(phaseForState('organizing'), 'organization');
  assert.equal(phaseForState('waiting_approval'), 'human');
  assert.equal(phaseForState('waiting_attention'), 'human');
  assert.equal(phaseForState('done'), 'terminal');
  assert.equal(phaseForState('replied'), 'terminal');
  assert.equal(phaseForState('published'), 'accepted');
});

test('nonterminal states drive polling, so done and replied are excluded', () => {
  assert.equal(nonterminalMessageState('thinking'), true);
  assert.equal(nonterminalMessageState('waiting_approval'), true);
  assert.equal(nonterminalMessageState('done'), false);
  assert.equal(nonterminalMessageState('replied'), false);
  assert.equal(nonterminalMessageState('failed'), false);
});

test('provider failures are classified, not collapsed', () => {
  // `unavailableError` is the narrower predicate: it decides whether a failure
  // means "the provider/config is unusable" rather than "this task failed".
  assert.equal(unavailableError('model catalog is unavailable'), true);
  assert.equal(unavailableError('Boss model provider returned HTTP 502 upstream'), true);
  assert.equal(unavailableError('model response is not valid JSON'), true);
  assert.equal(unavailableError('selected model is not available'), true);
  assert.equal(unavailableError('HTTP 429 rate limit'), false, 'rate limiting is not a config fault');
  assert.equal(unavailableError('Agent task failed.'), false);
  assert.equal(unavailableError(null), false);

  assert.match(unavailableBody(new Error('HTTP 429')), /请求过多/);
  assert.match(unavailableBody(new Error('HTTP 502 upstream')), /暂不可用/);
  assert.match(unavailableBody(new Error('not valid JSON')), /不符合 Runtime 契约/);
  assert.match(unavailableBody(new Error('contains secret-like content')), /敏感内容/);
});

test('an exhausted transient-busy error tells the reader to retry or switch models', () => {
  const error = new Error('Model provider returned HTTP 400.（已尝试 3 次）');
  assert.equal(unavailableError(error.message), true);
  assert.match(unavailableBody(error), /稍后重试|切换模型/);
});

test('reasoning effort has no default and accepts whatever a model publishes', () => {
  /*
   * The old rule answered `medium` for an absent value and threw for anything
   * outside `low|medium|high`. Both halves were wrong once the gateway started
   * publishing four to six levels per model: `medium` is not a level every model
   * has, and `xhigh` is one several do.
   *
   * What survives here is shape checking only. Whether a token is *allowed* is
   * a question about a specific model, answered by the catalogue.
   */
  assert.equal(parseReasoningEffort(undefined), undefined, 'an absent value is not a default');
  assert.equal(parseReasoningEffort('  '), undefined, 'blank is treated as absent');
  assert.equal(parseReasoningEffort('low'), 'low');
  assert.equal(parseReasoningEffort('high'), 'high');
  assert.equal(parseReasoningEffort('xhigh'), 'xhigh', 'levels beyond the old three work');
  assert.equal(parseReasoningEffort('ultra'), 'ultra');
  assert.throws(() => parseReasoningEffort(1), /string/);
  assert.throws(() => parseReasoningEffort('a'.repeat(64)), /short lowercase token/);
  assert.throws(() => parseReasoningEffort('HIGH!'), /short lowercase token/);
});
