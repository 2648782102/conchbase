/**
 * Long chain: each step depends on the previous one, so a single wrong step
 * makes the final artefact wrong. This is the case where "it looked like it
 * worked" diverges from "it is correct".
 */
export default {
  id: 'long-chain',
  instructions: [
    '你是数据流水线执行者。每一步都必须基于上一步的真实结果，不要跳步。',
    '需要信息时用工具读取，不要猜测。',
  ].join(' '),
  tools: ['workspace_list', 'workspace_read', 'workspace_write'],
  setup() {
    return {
      'data/step1.txt': 'seed=17\n',
      'data/step2.txt': 'multiplier=3\n',
      'data/step3.txt': 'offset=5\n',
    };
  },
  prompt: [
    '按顺序执行流水线：',
    '1. 读取 data/step1.txt 得到 seed；',
    '2. 读取 data/step2.txt 得到 multiplier；',
    '3. 读取 data/step3.txt 得到 offset；',
    '4. 计算 result = seed * multiplier + offset；',
    '5. 把 {"seed":<n>,"multiplier":<n>,"offset":<n>,"result":<n>} 写入 data/result.json；',
    '6. 读回 result.json 核对后回答。',
  ].join('\n'),
  async assert({ run, read }) {
    if (run.state !== 'replied' && run.state !== 'succeeded') {
      return { passed: false, reason: `state ${run.state}: ${run.error ?? ''}` };
    }
    const raw = read('data/result.json');
    if (raw === null) return { passed: false, reason: 'data/result.json was not written' };
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { passed: false, reason: `invalid JSON: ${raw.slice(0, 200)}` };
    }
    const expected = { seed: 17, multiplier: 3, offset: 5, result: 56 };
    for (const [key, value] of Object.entries(expected)) {
      if (parsed[key] !== value) return { passed: false, reason: `${key}=${parsed[key]} != ${value}` };
    }
    if (run.toolCalls < 4) return { passed: false, reason: `only ${run.toolCalls} tool calls for a 4-step chain` };
    return { passed: true };
  },
};
