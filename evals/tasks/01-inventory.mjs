/**
 * Long task: survey a nested workspace and produce a factual inventory.
 *
 * What it exercises: multi-step discovery (list, descend, read), aggregation
 * across files, and writing a derived artefact. The assertion checks numbers
 * that can only be right if every file was actually read.
 */
export default {
  id: 'inventory',
  instructions: [
    '你是仓库盘点员。使用工具查看工作区，不要凭猜测。',
    '完成后必须把结果写入 inventory.json，再结束。',
    '数字必须来自实际读取，不得估算。',
  ].join(' '),
  tools: ['workspace_list', 'workspace_read', 'workspace_write'],
  setup() {
    return {
      'src/alpha.txt': 'line1\nline2\nline3\n',
      'src/beta.txt': 'only\n',
      'docs/readme.md': '# Title\ntext\n',
      'docs/deep/notes.md': 'a\nb\n',
    };
  },
  prompt: [
    '盘点工作区：统计所有 .txt 和 .md 文件的数量，以及它们总行数。',
    '把结果写入 inventory.json，格式严格为：',
    '{"fileCount": <number>, "totalLines": <number>, "files": ["<relative path>", ...]}',
    '写入后再读回来核对一次，然后回答完成。',
  ].join('\n'),
  async assert({ run, read }) {
    // The expected values are computed from the fixture, not from the model.
    const expectedFiles = ['docs/deep/notes.md', 'docs/readme.md', 'src/alpha.txt', 'src/beta.txt'];
    const expectedLines = 3 + 1 + 2 + 2;
    if (run.state !== 'replied' && run.state !== 'succeeded') {
      return { passed: false, reason: `task ended in state ${run.state}: ${run.error ?? ''}` };
    }
    const raw = read('inventory.json');
    if (raw === null) return { passed: false, reason: 'inventory.json was never written' };
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { passed: false, reason: `inventory.json is not valid JSON: ${raw.slice(0, 200)}` };
    }
    if (parsed.fileCount !== expectedFiles.length) {
      return { passed: false, reason: `fileCount ${parsed.fileCount} != ${expectedFiles.length}` };
    }
    if (parsed.totalLines !== expectedLines) {
      return { passed: false, reason: `totalLines ${parsed.totalLines} != ${expectedLines}` };
    }
    const listed = [...(parsed.files ?? [])].map(String).sort();
    if (JSON.stringify(listed) !== JSON.stringify(expectedFiles)) {
      return { passed: false, reason: `files ${JSON.stringify(listed)} != ${JSON.stringify(expectedFiles)}` };
    }
    if (run.toolCalls < 4) {
      return { passed: false, reason: `only ${run.toolCalls} tool calls; reading 4 files needs at least that many` };
    }
    return { passed: true };
  },
};
