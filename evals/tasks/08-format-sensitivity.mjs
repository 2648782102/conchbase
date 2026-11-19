/**
 * Format sensitivity: a strict output contract that must be honoured exactly,
 * testing that the Runtime/model follows precise structured-output requests.
 */
export default {
  id: 'format-sensitivity',
  instructions: ['你是数据录入员。严格按照用户给的格式输出，不要加解释。'],
  tools: ['workspace_read', 'workspace_write'],
  setup() { return { 'values.csv': 'apple,3\nbanana,5\ncherry,2\n' }; },
  prompt: [
    '读取 values.csv，统计每种水果的数量之和。',
    '把结果写入 total.json，内容必须严格是 {"total": <number>}（合法 JSON，无多余文字）。',
    '已知三行数量为 3、5、2。写入后结束。',
  ].join('\n'),
  async assert({ read, run }) {
    if (run.state !== 'replied' && run.state !== 'succeeded') {
      return { passed: false, reason: `task ended in ${run.state}: ${run.error ?? ''}` };
    }
    const raw = read('total.json');
    if (raw === null) return { passed: false, reason: 'total.json was never written' };
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return { passed: false, reason: `total.json invalid JSON: ${raw.slice(0, 100)}` }; }
    if (parsed.total !== 10) return { passed: false, reason: `total = ${parsed.total}, expected 10` };
    if (Object.keys(parsed).some((key) => key !== 'total')) return { passed: false, reason: 'extra keys in total.json' };
    return { passed: true };
  },
};
