/**
 * Robustness: the model is tempted into a bad tool call, then must recover.
 * Asserts on the trace: a failed call is tolerated and the correct artefact is
 * still produced, without repeated identical failing calls (no-progress loop).
 */
export default {
  id: 'tool-error-recovery',
  instructions: [
    '你是文件整理员。只能用提供的工具，不要凭猜测。',
    '如果一次工具调用失败，换一种正确方式，不要反复用同样的失败参数。',
    '完成后把结果写入 result.txt 再结束。',
  ].join(' '),
  tools: ['workspace_list', 'workspace_read', 'workspace_write'],
  setup() {
    return { 'data.txt': 'alpha\nbeta\ngamma\n' };
  },
  prompt: [
    '工作区有 data.txt。先尝试读取一个不存在的文件 missing.txt（看看会发生什么），',
    '然后读取 data.txt，把它的行数写入 result.txt，格式严格为单行数字（例如 3）。',
    '必须真正写入文件。',
  ].join('\n'),
  async assert({ run, read }) {
    if (run.state !== 'replied' && run.state !== 'succeeded') {
      return { passed: false, reason: `task ended in state ${run.state}: ${run.error ?? ''}` };
    }
    const raw = read('result.txt');
    if (raw === null) return { passed: false, reason: 'result.txt was never written' };
    if (raw.trim() !== '3') return { passed: false, reason: `result.txt = ${JSON.stringify(raw)}, expected "3"` };
    // A transient failure is fine; an unbounded retry loop is not.
    if (run.toolCalls > 12) return { passed: false, reason: `${run.toolCalls} tool calls suggests a no-progress loop` };
    return { passed: true };
  },
};
