import type { OrganizationSnapshot } from './organization-contract.js';
import {
  scheduleGlobalWork,
  type HoldReason,
  type SchedulerLimits,
  DEFAULT_SCHEDULER_LIMITS,
} from './global-work-scheduler.js';

/**
 * Read-only projection of scheduled holds onto published work items.
 *
 * A hold is not stored in the organization event log: the worker remains
 * `authorized` and its WorkItem stays open. This projection derives why it has
 * not started from the current capacity, so a client can explain the delay
 * after a refresh without adding a second work authority.
 */
export interface WorkHoldProjection {
  readonly workItemId: string;
  readonly projectId: string;
  readonly workerId: string;
  readonly heldBy: HoldReason;
}

export function projectWorkHolds(
  snapshot: OrganizationSnapshot,
  limits: SchedulerLimits = DEFAULT_SCHEDULER_LIMITS,
): readonly WorkHoldProjection[] {
  // Running workers must consume capacity even though they are not candidates
  // for a hold themselves. Without them the projection would under-report holds.
  const running = snapshot.workers
    .filter((worker) => worker.state === 'running')
    .map((worker, index) => Object.freeze({
      workItemId: `work_${worker.id}`,
      projectId: worker.projectId,
      state: 'running' as const,
      priority: 'normal' as const,
      enqueueSequence: index,
    }));
  const candidates = snapshot.workers
    .filter((worker) => worker.state === 'authorized' || worker.state === 'idle')
    .map((worker, index) => {
      const project = snapshot.projects.find((item) => item.id === worker.projectId);
      const attention = snapshot.attentionRequests.some((request) =>
        request.state === 'open' && request.projectId === worker.projectId);
      return Object.freeze({
        workItemId: `work_${worker.id}`,
        projectId: worker.projectId,
        workerId: worker.id,
        state: 'open' as const,
        priority: attention ? 'interactive' as const : 'normal' as const,
        enqueueSequence: index,
        activeProject: project?.state === 'active' || project?.state === 'resumed',
      });
    })
    .filter((candidate) => candidate.activeProject);
  const scheduled = scheduleGlobalWork([
    ...running,
    ...candidates.map(({ activeProject: _activeProject, ...item }) => item),
  ], limits);
  const reasons = new Map(
    scheduled.decisions
      .filter((decision) => decision.type === 'hold')
      .map((decision) => [decision.workItemId, decision.reason]),
  );
  return Object.freeze(candidates
    .filter((candidate) => reasons.has(candidate.workItemId))
    .map((candidate) => Object.freeze({
      workItemId: candidate.workItemId,
      projectId: candidate.projectId,
      workerId: candidate.workerId,
      heldBy: reasons.get(candidate.workItemId)!,
    })));
}
