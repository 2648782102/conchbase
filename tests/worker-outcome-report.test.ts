import assert from 'node:assert/strict';
import test from 'node:test';
import { composeOutcomeReply } from '../src/runtime/worker-outcome-report.js';

test('the reply reports real outcomes with per-worker state', () => {
  const reply = composeOutcomeReply([
    { workerId: 'wrk_a', displayName: '员工 A', taskState: 'succeeded', body: '完成 A' },
    { workerId: 'wrk_b', displayName: '员工 B', taskState: 'failed', body: '失败原因 B' },
  ]);
  assert.match(reply, /2 名中 1 名成功/);
  assert.match(reply, /员工 A（wrk_a）· 已完成/);
  assert.match(reply, /员工 B（wrk_b）· 失败/);
  assert.match(reply, /失败原因 B/);
});

test('an empty body is stated rather than rendered as blank', () => {
  const reply = composeOutcomeReply([
    { workerId: 'wrk_c', displayName: '员工 C', taskState: 'succeeded', body: '   ' },
  ]);
  assert.match(reply, /没有返回正文/);
});

test('cancelled and interrupted are distinguished from failed', () => {
  const reply = composeOutcomeReply([
    { workerId: 'w1', displayName: '一', taskState: 'cancelled', body: '' },
    { workerId: 'w2', displayName: '二', taskState: 'interrupted', body: '' },
  ]);
  assert.match(reply, /已取消/);
  assert.match(reply, /已中断/);
});

test('a secret-like body is withheld instead of published', () => {
  // Worker output is untrusted model text; it must not carry a credential into
  // the Boss reply.
  const reply = composeOutcomeReply([
    { workerId: 'wrk_x', displayName: '员工 X', taskState: 'succeeded', body: 'token is sk-abcdef123456' },
  ]);
  assert.match(reply, /疑似敏感内容/);
  assert.doesNotMatch(reply, /sk-abcdef123456/);
});

test('the reply stays within the published bound', () => {
  const reply = composeOutcomeReply([
    { workerId: 'wrk_big', displayName: '长', taskState: 'succeeded', body: 'x'.repeat(50_000) },
  ]);
  assert.ok(reply.length <= 11_500, `reply was ${reply.length} characters`);
});
