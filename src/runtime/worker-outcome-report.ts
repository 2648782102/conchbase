import { containsSecretLike } from './secret-filter.js';

/**
 * What one hired worker actually produced.
 *
 * Distinct from the durable `OrganizationReport`: this is the in-process result
 * used to answer the user in the same turn, before any of it is persisted.
 */
export interface WorkerOutcome {
  readonly workerId: string;
  readonly displayName: string;
  readonly taskState: 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  readonly body: string;
}

const MAX_BODY = 1_200;
const MAX_RENDERED = 11_500;

/**
 * Renders the Boss reply from real outcomes.
 *
 * The model's pre-execution relay cannot state a result, so the final answer is
 * composed from what workers actually returned. Two constraints matter:
 * worker output is untrusted model text (it must not smuggle a secret-like
 * value), and the reply stays within the published bound.
 */
export function composeOutcomeReply(outcomes: readonly WorkerOutcome[]): string {
  const succeeded = outcomes.filter((outcome) => outcome.taskState === 'succeeded').length;
  const body = outcomes.map((outcome) => {
    const state = outcome.taskState === 'succeeded' ? '已完成' : outcome.taskState === 'cancelled'
      ? '已取消'
      : outcome.taskState === 'interrupted' ? '已中断' : '失败';
    const text = outcome.body.trim().length > 0
      ? outcome.body.trim().slice(0, MAX_BODY)
      : '（员工没有返回正文）';
    return `- ${outcome.displayName}（${outcome.workerId}）· ${state}\n${text}`;
  });
  const composed = [
    `员工执行完成：${outcomes.length} 名中 ${succeeded} 名成功。`,
    ...body,
  ].join('\n\n');
  if (containsSecretLike(composed)) {
    return `员工执行完成：${outcomes.length} 名中 ${succeeded} 名成功。汇报正文包含疑似敏感内容，已隐藏。`;
  }
  return composed.slice(0, MAX_RENDERED);
}
