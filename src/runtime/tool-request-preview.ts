/**
 * A bounded, renderable summary of a pending write request.
 *
 * Computed at request time from the arguments the caller already supplied; it is
 * never persisted, so it cannot drift from durable state. It is safe to render
 * in a client: the target is workspace-relative, the diff is bounded, and
 * secret-like content is withheld rather than shown.
 */
import { containsSecretLike } from './secret-filter.js';

export const PREVIEW_LIMITS = Object.freeze({
  target: 200,
  summary: 240,
  diffBytes: 2_000,
  riskNote: 240,
});

export type PreviewEffect = 'create' | 'modify' | 'delete';

export interface ToolRequestPreview {
  readonly targetLabel: string;
  readonly effect: PreviewEffect;
  readonly reversible: boolean;
  readonly summary: string;
  readonly diff?: string;
  readonly riskNote?: string;
}

/** Tools that change a file, and so can produce a preview. */
const WRITE_TOOLS = new Set(['workspace_write']);

function safeRelative(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > PREVIEW_LIMITS.target) return null;
  if (value.includes('\0') || value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) return null;
  if (value.split(/[\\/]/).includes('..')) return null;
  return value;
}

function lineDiff(before: string, after: string, budget: number): string {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  const lines: string[] = [];
  const max = Math.max(beforeLines.length, afterLines.length);
  for (let i = 0; i < max; i += 1) {
    const old = beforeLines[i];
    const next = afterLines[i];
    if (old === next) continue;
    if (old !== undefined) lines.push(`-${old}`);
    if (next !== undefined) lines.push(`+${next}`);
    if (lines.join('\n').length >= budget) break;
  }
  const text = lines.join('\n');
  if (Buffer.byteLength(text, 'utf8') <= budget) return text;
  return `${text.slice(0, budget)}\n[truncated at ${budget} bytes]`;
}

export function buildToolRequestPreview(input: {
  readonly toolName: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly existing: string | null;
}): ToolRequestPreview | null {
  if (!WRITE_TOOLS.has(input.toolName)) return null;
  const target = safeRelative(input.arguments.path);
  if (target === null) return null;
  const content = typeof input.arguments.content === 'string' ? input.arguments.content : null;
  if (content === null) return null;
  // A secret-like body is withheld: the reviewer can still approve by digest,
  // but the value must never be displayed.
  if (containsSecretLike(content)) {
    return Object.freeze({
      targetLabel: target,
      effect: input.existing === null ? 'create' : 'modify',
      reversible: true,
      summary: `write ${target} (${Buffer.byteLength(content, 'utf8')} bytes; content withheld)`,
      riskNote: 'content looks secret-like and is not shown',
    });
  }

  const effect: PreviewEffect = input.existing === null ? 'create' : 'modify';
  const bytes = Buffer.byteLength(content, 'utf8');
  const previousBytes = input.existing === null ? 0 : Buffer.byteLength(input.existing, 'utf8');
  const summary = effect === 'create'
    ? `create ${target} (${bytes} bytes)`
    : `replace ${target} (${previousBytes} → ${bytes} bytes)`;
  const diff = input.existing === null
    ? `+${content.slice(0, PREVIEW_LIMITS.diffBytes)}`
    : lineDiff(input.existing, content, PREVIEW_LIMITS.diffBytes);
  const truncatedDiff = Buffer.byteLength(diff, 'utf8') > PREVIEW_LIMITS.diffBytes
    ? `${diff.slice(0, PREVIEW_LIMITS.diffBytes)}\n[truncated at ${PREVIEW_LIMITS.diffBytes} bytes]`
    : diff;
  return Object.freeze({
    targetLabel: target,
    effect,
    reversible: true,
    summary: summary.slice(0, PREVIEW_LIMITS.summary),
    ...(truncatedDiff.length > 0 ? { diff: truncatedDiff } : {}),
    ...(effect === 'modify'
      ? { riskNote: `replaces existing content of ${target}`.slice(0, PREVIEW_LIMITS.riskNote) }
      : {}),
  });
}
