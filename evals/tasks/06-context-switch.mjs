/**
 * Context switch inside one conversation: the user changes the requirement
 * after the agent has already started. The final artefact must reflect the new
 * requirement, and the old work must not silently win.
 */
export default {
  id: 'context-switch',
  instructions: [
    '用户可能中途改变要求。以最新要求为准，不要保留已作废的产物。',
    '需要信息时用工具，不要凭记忆编造。',
  ].join(' '),
  tools: ['workspace_list', 'workspace_read', 'workspace_write'],
  setup() {
    return { 'source.txt': 'alpha\nbeta\ngamma\n' };
  },
  prompt: [
    '第一步：读取 source.txt，把每行转成大写写入 upper.txt。',
    '第二步（这是最终要求）：取消 upper.txt 方案，改成把每行前面加 "- " 写入 bullets.txt，并删除 upper.txt（如果已创建）。',
    '最终只保留 bullets.txt，内容为带 "- " 前缀的原始行。',
  ].join('\n'),
  async assert({ run, read }) {
    if (run.state !== 'replied' && run.state !== 'succeeded') {
      return { passed: false, reason: `state ${run.state}: ${run.error ?? ''}` };
    }
    const bullets = read('bullets.txt');
    const upper = read('upper.txt');
    if (bullets === null) return { passed: false, reason: 'bullets.txt was not written' };
    const lines = bullets.trim().split('\n');
    const expected = ['- alpha', '- beta', '- gamma'];
    if (JSON.stringify(lines) !== JSON.stringify(expected)) {
      return { passed: false, reason: `bullets.txt = ${JSON.stringify(lines)}` };
    }
    if (upper !== null && /ALPHA/.test(upper)) {
      return { passed: false, reason: 'the superseded upper.txt still exists with old content' };
    }
    return { passed: true };
  },
};
