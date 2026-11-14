const COMMON_ROLE_NAMES: Readonly<Record<string, string>> = Object.freeze({
  alpha: '甲',
  aurora: '曙光',
  beta: '乙',
  planner: '规划员',
  researcher: '研究员',
  reviewer: '审阅员',
  scout: '侦察员',
  validator: '校验员',
  worker: '员工',
});

const ROLE_ALIASES: readonly (readonly [RegExp, string])[] = Object.freeze([
  [/^worker-validator$/i, '校验员'],
  [/^worker-scout$/i, '侦察员'],
  [/^worker-(.+)$/i, '$1'],
  [/^employee-(.+)$/i, '$1'],
]);

function translateToken(token: string): string {
  return COMMON_ROLE_NAMES[token.toLowerCase()] ?? token;
}

export function chineseAgentDisplayName(raw: string): string {
  const value = raw.trim();
  if (value.length === 0) return '员工';
  if (/[\u3400-\u9fff]/.test(value)) return value.slice(0, 80);
  for (const [pattern, replacement] of ROLE_ALIASES) {
    const match = pattern.exec(value);
    if (!match) continue;
    const translated = replacement.replace(/\$(\d+)/g, (_candidate, index: string) => {
      const group = match[Number(index)] ?? '';
      return translateToken(group);
    });
    return translated.slice(0, 80);
  }
  const translated = value
    .split(/[-_\s]+/)
    .filter((token) => token.length > 0)
    .map(translateToken)
    .join('·');
  return (translated.length > 0 ? translated : '员工').slice(0, 80);
}
