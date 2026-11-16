import {
  MEMORY_LIMITS,
  renderMemoryIndex,
  type AgentMemoryInput,
  type AgentMemoryStore,
} from './agent-memory.js';
import type { MemoryReviewInput, MemoryReviewResult } from './memory-review.js';
import type { OrganizationSnapshot } from './organization-contract.js';

/**
 * Memory on behalf of the Boss conversation.
 *
 * Two responsibilities that are easy to confuse and were previously interleaved
 * with dispatch logic:
 *
 *  1. Decide what recollection to *show* the model — a bounded index, scoped to
 *     runtime-wide facts plus the projects currently in play.
 *  2. Decide what proposals to *persist* — after Runtime checks and, when
 *     configured, an independent review.
 *
 * Neither may influence execution: memory is advisory context, and a write
 * never grants capability or authorises an action.
 */

export type MemoryReviewer = (input: MemoryReviewInput) => Promise<MemoryReviewResult | null>;

export interface BossMemoryOptions {
  readonly memory?: AgentMemoryStore;
  readonly reviewer?: MemoryReviewer;
}

export class BossMemory {
  private readonly memory: AgentMemoryStore | undefined;
  private readonly reviewer: MemoryReviewer | undefined;

  constructor(options: BossMemoryOptions = {}) {
    this.memory = options.memory;
    this.reviewer = options.reviewer;
  }

  /** The compact index injected into the Boss prompt, or '' when unavailable. */
  index(snapshot: OrganizationSnapshot): string {
    const memory = this.memory;
    if (!memory) return '';
    try {
      const activeProjectIds = new Set(
        snapshot.projects
          .filter((project) => project.state === 'active' || project.state === 'resumed')
          .map((project) => project.id),
      );
      const entries = [
        ...memory.list({ scope: 'runtime', limit: MEMORY_LIMITS.injected }),
        ...snapshot.projects
          .filter((project) => activeProjectIds.has(project.id))
          .flatMap((project) => memory.list({ scope: 'project', scopeId: project.id, limit: 4 })),
      ];
      return renderMemoryIndex(entries);
    } catch {
      // Memory is an enhancement; a failure must never break a conversation.
      return '';
    }
  }

  /**
   * Persists proposals the model made, after Runtime checks.
   *
   * Precedence is deliberate: shape and target existence are decided by the
   * Runtime, a reviewer can only narrow the set, and a configured-but-failing
   * reviewer means nothing is written.
   */
  async recordProposals(
    entries: readonly AgentMemoryInput[],
    context: {
      readonly userText: string;
      readonly assistantReply: string;
      readonly sourceIntentId: string;
      readonly snapshot: OrganizationSnapshot;
    },
  ): Promise<void> {
    const memory = this.memory;
    if (!memory) return;
    const candidates = entries.filter((entry) => {
      if (entry.scope === 'runtime') {
        // A global fact needs an independent confirmation; without a reviewer
        // that cannot be established, so it is dropped.
        return Boolean(this.reviewer);
      }
      return entry.scope === 'project'
        ? context.snapshot.projects.some((project) => project.id === entry.scopeId)
        : context.snapshot.workers.some((worker) => worker.id === entry.scopeId);
    });
    if (candidates.length === 0) return;

    let accepted: readonly AgentMemoryInput[] = candidates;
    if (this.reviewer) {
      let review: MemoryReviewResult | null = null;
      try {
        review = await this.reviewer({
          userText: context.userText,
          assistantReply: context.assistantReply,
          existingTitles: [...new Set(candidates.flatMap((entry) => memory.list({
            scope: entry.scope,
            ...(entry.scopeId ? { scopeId: entry.scopeId } : {}),
            limit: 24,
          }).map((stored) => stored.title)))],
          proposals: candidates,
        });
      } catch {
        review = null;
      }
      if (!review) return;
      const verdicts = new Map(review.decisions.map((decision) => [decision.index, decision]));
      accepted = candidates.filter((entry, index) => {
        const verdict = verdicts.get(index);
        if (verdict?.verdict !== 'accept') return false;
        if (entry.scope === 'runtime' && verdict.runtimeScopeConfirmed !== true) return false;
        return true;
      });
    }

    for (const entry of accepted) {
      try {
        memory.write({
          ...entry,
          sourceIntentId: context.sourceIntentId,
          origin: 'conversational',
          ...(this.reviewer ? { reviewedBy: 'accepted' as const } : {}),
        });
      } catch {
        // Memory is advisory; a rejected write must not break the turn.
      }
    }
  }
}
