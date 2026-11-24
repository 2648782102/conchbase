/**
 * Long task: a real code change with a behavioural requirement.
 *
 * The point is not "did it edit text" but "does the changed code still parse and
 * behave". The fixture is a tiny script with a known bug; the agent must fix it
 * and the harness verifies by reading the file, not by trusting the summary.
 */
export default {
  id: 'refactor',
  instructions: [
    '你是工程师。先用工具读懂代码，再修改。',
    '改完必须自己验证逻辑，不要只说已经改好。',
    '只改必要的文件。',
  ].join(' '),
  tools: ['workspace_list', 'workspace_read', 'workspace_write'],
  setup() {
    return {
      'sum.js': [
        '// 计算数组总和。',
        'function sum(values) {',
        '  let total = 0;',
        '  for (let i = 0; i <= values.length; i += 1) {',
        '    total += values[i];',
        '  }',
        '  return total;',
        '}',
        'module.exports = { sum };',
        '',
      ].join('\n'),
      'sum.test.js': [
        "const { sum } = require('./sum.js');",
        "if (sum([1, 2, 3]) !== 6) { console.error('FAIL'); process.exit(1); }",
        "console.log('OK');",
        '',
      ].join('\n'),
    };
  },
  prompt: [
    'sum.js 的 sum 函数有缺陷：数组含 NaN 时结果不正确，且循环边界写错了。',
    '请修复 sum.js，使其满足：',
    '1. 对 [1,2,3] 返回 6；',
    '2. 对 [] 返回 0；',
    '3. 数组中的 NaN 被跳过，不计入总和；',
    '4. 循环不越界。',
    '覆盖已存在文件时，workspace_write 必须传 overwrite: true；只写新文件不算完成。',
    '修改后用工具读回文件确认内容，再回答。',
  ].join('\n'),
  async assert({ run, read }) {
    if (run.state !== 'replied' && run.state !== 'succeeded') {
      return { passed: false, reason: `task ended in state ${run.state}: ${run.error ?? ''}` };
    }
    const source = read('sum.js');
    if (source === null) return { passed: false, reason: 'sum.js disappeared' };
    if (source.includes('i <= values.length')) {
      return { passed: false, reason: 'the out-of-bounds loop condition is still present' };
    }
    // Execute the result: the decisive proof is behaviour, not the diff.
    const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const { spawnSync } = await import('node:child_process');
    const directory = mkdtempSync(path.join(tmpdir(), 'eval-refactor-'));
    try {
      writeFileSync(path.join(directory, 'sum.js'), source);
      writeFileSync(path.join(directory, 'check.js'), [
        "const { sum } = require('./sum.js');",
        'const cases = [[[1,2,3],6], [[],0], [[1,NaN,2],3], [[NaN],0]];',
        'for (const [input, expected] of cases) {',
        '  const actual = sum(input);',
        "  if (actual !== expected) { console.error('case failed', JSON.stringify(input), actual, expected); process.exit(1); }",
        '}',
        "console.log('OK');",
      ].join('\n'));
      const result = spawnSync(process.execPath, ['check.js'], { cwd: directory, encoding: 'utf8' });
      if (result.status !== 0) {
        return { passed: false, reason: `behaviour check failed: ${(result.stderr || result.stdout).slice(0, 300)}` };
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    return { passed: true };
  },
};
