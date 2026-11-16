import type { OrganizationSnapshot } from './organization-contract.js';

/**
 * One worker's runtime execution binding.
 *
 * Recorded durably as an `organization.worker_execution_recorded` event, which
 * is the authority: the in-process maps are a cache rebuilt from this log on
 * startup. That is why offboarding must not delete the record — resume needs the
 * Agent and revision ids to recreate a usable Agent.
 */
export interface WorkerExecutionRecord {
  readonly workerId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly workItemId: string;
  readonly agentId: string;
  readonly agentRevisionId: string;
  readonly delegationId: string;
}

/**
 * Rebuilds the worker bindings from durable events.
 *
 * Pure: takes a snapshot, returns records. A record is only produced when the
 * event carries every identity and the worker still exists in the snapshot;
 * a half-written event must not become a binding that later dispatch trusts.
 *
 * Later events for the same worker win, because a re-run binds fresh work.
 */
export function restoreWorkerExecutions(
  snapshot: OrganizationSnapshot,
): ReadonlyMap<string, WorkerExecutionRecord> {
  const records = new Map<string, WorkerExecutionRecord>();
  for (const event of snapshot.events) {
    if (event.type !== 'organization.worker_execution_recorded') continue;
    const workerId = String(event.data.workerId ?? '');
    const taskId = String(event.data.taskId ?? '');
    const workItemId = String(event.data.workItemId ?? '');
    const agentId = String(event.data.agentId ?? '');
    if (!workerId || !taskId || !workItemId || !agentId) continue;
    const worker = snapshot.workers.find((item) => item.id === workerId);
    if (!worker) continue;
    records.set(workerId, Object.freeze({
      workerId,
      projectId: event.projectId,
      taskId,
      workItemId,
      agentId,
      agentRevisionId: worker.agentRevisionId,
      delegationId: worker.delegationId,
    }));
  }
  return records;
}
