import { digestArguments } from './tool-arguments.js';

/**
 * Reuse of identical read results within one task attempt.
 *
 * A model that asks for the same file twice should not pay for it twice, and
 * more importantly should not be able to make a read look like new evidence.
 * Only reads are cached: replaying one has no side effect, while writes and
 * external calls keep their approval and idempotency behaviour.
 *
 * The cache is process-scoped and keyed by attempt, so a retry always observes
 * fresh data rather than a stale copy from the previous attempt.
 */
export interface CachedReadResult {
  readonly summary: string;
  readonly digest: string;
}

export class ReadResultCache {
  private readonly entries = new Map<string, CachedReadResult>();

  private static key(taskId: string, attempt: number, toolId: string, args: unknown): string {
    return `${taskId}:${attempt}:${toolId}:${digestArguments(args as Record<string, string | number | boolean | null>)}`;
  }

  get(taskId: string, attempt: number, toolId: string, args: unknown): CachedReadResult | undefined {
    return this.entries.get(ReadResultCache.key(taskId, attempt, toolId, args));
  }

  set(
    taskId: string,
    attempt: number,
    toolId: string,
    args: unknown,
    result: CachedReadResult,
  ): void {
    this.entries.set(ReadResultCache.key(taskId, attempt, toolId, args), result);
  }

  /** Drops every entry for one task, regardless of attempt. */
  clear(taskId: string): void {
    const prefix = `${taskId}:`;
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  /** Visible for tests and diagnostics only. */
  size(): number {
    return this.entries.size;
  }
}
