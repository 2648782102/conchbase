/**
 * Non-preemptive global work scheduling policy.
 *
 * The scheduler is pure: it reads a snapshot of work and returns decisions. It
 * never starts, cancels, or mutates a task. That keeps the Runtime's single
 * writer rule intact and makes fairness testable without a live loop.
 */

export const GLOBAL_WORK_SCHEDULER_VERSION = 1;

export const DEFAULT_SCHEDULER_LIMITS = Object.freeze({
  globalActive: 8,
  perProjectActive: 2,
});

export const MAX_SCHEDULER_LIMITS = Object.freeze({
  globalActive: 32,
  perProjectActive: 16,
});

export type WorkPriority = 'interactive' | 'normal';

export type HoldReason = 'global-limit' | 'project-limit';

export interface SchedulableWork {
  readonly workItemId: string;
  readonly projectId: string;
  readonly state: 'open' | 'running' | 'paused' | 'completed' | 'cancelled';
  readonly priority: WorkPriority;
  readonly enqueueSequence: number;
}

export interface SchedulerLimits {
  readonly globalActive: number;
  readonly perProjectActive: number;
}

export interface StartDecision {
  readonly type: 'start';
  readonly workItemId: string;
  readonly projectId: string;
  readonly reason: 'capacity-available';
}

export interface HoldDecision {
  readonly type: 'hold';
  readonly workItemId: string;
  readonly projectId: string;
  readonly reason: HoldReason;
}

export type SchedulerDecision = StartDecision | HoldDecision;

export interface ScheduleResult {
  readonly version: typeof GLOBAL_WORK_SCHEDULER_VERSION;
  readonly decisions: readonly SchedulerDecision[];
  readonly activeWorkItemIds: readonly string[];
}

function parseLimit(value: number | undefined, fallback: number, max: number, label: string): number {
  const candidate = value ?? fallback;
  if (!Number.isInteger(candidate) || candidate < 1 || candidate > max) {
    throw new Error(`${label} must be an integer from 1 to ${max}.`);
  }
  return candidate;
}

/**
 * Chooses which queued work may start.
 *
 * Ordering rules:
 *  1. interactive work before normal work;
 *  2. projects with fewer running tasks before projects with more;
 *  3. earlier `enqueueSequence` before later within the same class.
 *
 * Running tasks are counted, never stopped. A task that cannot start because of
 * capacity produces a visible `hold` decision rather than disappearing.
 */
export function scheduleGlobalWork(
  work: readonly SchedulableWork[],
  limits: SchedulerLimits = DEFAULT_SCHEDULER_LIMITS,
): ScheduleResult {
  const globalActive = parseLimit(
    limits.globalActive, DEFAULT_SCHEDULER_LIMITS.globalActive,
    MAX_SCHEDULER_LIMITS.globalActive, 'globalActive',
  );
  const perProjectActive = parseLimit(
    limits.perProjectActive, DEFAULT_SCHEDULER_LIMITS.perProjectActive,
    MAX_SCHEDULER_LIMITS.perProjectActive, 'perProjectActive',
  );

  const running = work.filter((item) => item.state === 'running');
  const activeByProject = new Map<string, number>();
  for (const item of running) {
    activeByProject.set(item.projectId, (activeByProject.get(item.projectId) ?? 0) + 1);
  }

  const queued = work.filter((item) => item.state === 'open' || item.state === 'paused')
    .slice()
    .sort((left, right) => {
      if (left.priority !== right.priority) return left.priority === 'interactive' ? -1 : 1;
      const leftActive = activeByProject.get(left.projectId) ?? 0;
      const rightActive = activeByProject.get(right.projectId) ?? 0;
      if (leftActive !== rightActive) return leftActive - rightActive;
      return left.enqueueSequence - right.enqueueSequence;
    });

  const decisions: SchedulerDecision[] = [];
  let active = running.length;
  for (const item of queued) {
    const projectActive = activeByProject.get(item.projectId) ?? 0;
    if (active >= globalActive) {
      decisions.push(Object.freeze({
        type: 'hold' as const, workItemId: item.workItemId,
        projectId: item.projectId, reason: 'global-limit' as const,
      }));
      continue;
    }
    if (projectActive >= perProjectActive) {
      decisions.push(Object.freeze({
        type: 'hold' as const, workItemId: item.workItemId,
        projectId: item.projectId, reason: 'project-limit' as const,
      }));
      continue;
    }
    decisions.push(Object.freeze({
      type: 'start' as const, workItemId: item.workItemId,
      projectId: item.projectId, reason: 'capacity-available' as const,
    }));
    active += 1;
    activeByProject.set(item.projectId, projectActive + 1);
  }

  return Object.freeze({
    version: GLOBAL_WORK_SCHEDULER_VERSION,
    decisions: Object.freeze(decisions),
    activeWorkItemIds: Object.freeze(
      [...running.map((item) => item.workItemId),
        ...decisions.filter((decision) => decision.type === 'start').map((decision) => decision.workItemId)],
    ),
  });
}
