import {
  type OrganizationEvent,
  type OrganizationSnapshot,
} from './organization-contract.js';
import {
  planOrganizationExecution,
  type OrganizationCommand,
  type OrganizationExecutionLimits,
  type OrganizationRelay,
  type WorkStateView,
} from './organization-execution.js';
import {
  scheduleGlobalWork,
  type HoldReason,
  type SchedulerLimits,
  type SchedulableWork,
} from './global-work-scheduler.js';
import type { OrganizationStore } from './organization-store.js';

export const ORGANIZATION_COORDINATOR_CONTRACT_VERSION = 1;

export interface OrganizationControlResult {
  readonly command: OrganizationCommand;
  readonly outcome: 'dispatched' | 'failed';
  readonly error?: string;
}

export interface OrganizationHold {
  readonly workItemId: string;
  readonly projectId: string;
  readonly reason: HoldReason;
}

export interface OrganizationCoordinatorResult {
  readonly version: typeof ORGANIZATION_COORDINATOR_CONTRACT_VERSION;
  readonly snapshot: OrganizationSnapshot;
  readonly executions: readonly OrganizationControlResult[];
  readonly holds: readonly OrganizationHold[];
  readonly relays: readonly OrganizationRelay[];
}

export interface OrganizationWorkControls {
  readonly listWorkState: () => readonly WorkStateView[];
  readonly startWork?: (workItemId: string, expectedState: 'open' | 'paused') => void;
  readonly stopWork?: (workItemId: string, expectedState: 'running' | 'paused') => void;
  readonly completeWork?: (workItemId: string, expectedState: 'running') => void;
  readonly reconcileAssignment?: (
    workItemId: string,
    assignmentId: string,
    expectedState: 'running',
    outcome: 'succeeded' | 'failed',
  ) => void;
}

function commandKey(command: OrganizationCommand): string {
  return `${command.type}:${command.workItemId}:${command.assignmentId ?? ''}`;
}

function boundedError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : 'Unknown work-control failure.';
  return message.slice(0, 240).replace(/[\u0000-\u001f\u007f]/g, ' ');
}

export class OrganizationCoordinator {
  constructor(
    private readonly store: OrganizationStore,
    private readonly controls: OrganizationWorkControls,
    private readonly limits?: OrganizationExecutionLimits,
    private readonly schedulerLimits?: SchedulerLimits,
  ) {}

  submitAction(input: unknown): OrganizationCoordinatorResult {
    this.store.apply(input);
    return this.reconcile();
  }

  reconcile(): OrganizationCoordinatorResult {
    const snapshot = this.store.get();
    const workState = this.controls.listWorkState();
    const plan = planOrganizationExecution(snapshot, workState, this.limits);
    const admittedStarts = this.admitStarts(
      snapshot,
      plan.commands.filter((command) => command.type === 'start_work'),
      workState,
    );
    const dispatched = new Set<string>();
    const executions: OrganizationControlResult[] = [];
    const holds: OrganizationHold[] = [];
    for (const command of plan.commands) {
      const key = commandKey(command);
      if (dispatched.has(key)) continue;
      dispatched.add(key);
      if (command.type === 'start_work') {
        if (!admittedStarts.has(command.workItemId)) {
          holds.push(Object.freeze({
            workItemId: command.workItemId,
            projectId: this.projectIdForWork(snapshot, command.workItemId),
            reason: this.holdReason(command.workItemId),
          }));
          continue;
        }
      }
      executions.push(this.dispatch(command));
    }
    return Object.freeze({
      version: ORGANIZATION_COORDINATOR_CONTRACT_VERSION,
      snapshot,
      executions: Object.freeze(executions),
      holds: Object.freeze(holds),
      relays: plan.relays,
    });
  }

  private admitStarts(
    snapshot: OrganizationSnapshot,
    startCommands: readonly OrganizationCommand[],
    workState: readonly WorkStateView[],
  ): ReadonlySet<string> {
    const runningByProject = new Map<string, number>();
    for (const item of workState) {
      if (item.state !== 'running') continue;
      const projectId = this.projectIdForWork(snapshot, item.id);
      runningByProject.set(projectId, (runningByProject.get(projectId) ?? 0) + 1);
    }
    const candidate = startCommands.map((command, index) => {
      const projectId = this.projectIdForWork(snapshot, command.workItemId);
      const priority = snapshot.attentionRequests.some((request) =>
        request.state === 'open' && request.projectId === projectId)
        ? 'interactive' as const
        : 'normal' as const;
      return Object.freeze({
        workItemId: command.workItemId,
        projectId,
        state: 'open' as const,
        priority,
        // Deterministic order: existing running tasks first, then plan order.
        enqueueSequence: (runningByProject.get(projectId) ?? 0) * 1_000_000 + index,
      }) as SchedulableWork;
    });
    const scheduled = scheduleGlobalWork(candidate, this.schedulerLimits);
    this.lastHoldReasons = new Map(
      scheduled.decisions
        .filter((decision) => decision.type === 'hold')
        .map((decision) => [decision.workItemId, decision.reason]),
    );
    return new Set(
      scheduled.decisions
        .filter((decision) => decision.type === 'start')
        .map((decision) => decision.workItemId),
    );
  }

  private projectIdForWork(snapshot: OrganizationSnapshot, workItemId: string): string {
    for (const event of [...snapshot.events].reverse()) {
      if (event.type === 'organization.worker_execution_recorded' && event.data.workItemId === workItemId) {
        return event.projectId;
      }
    }
    return 'project_unknown';
  }

  private holdReason(workItemId: string): HoldReason {
    return this.lastHoldReasons.get(workItemId) ?? 'global-limit';
  }

  private lastHoldReasons = new Map<string, HoldReason>();

  private dispatch(command: OrganizationCommand): OrganizationControlResult {
    try {
      switch (command.type) {
        case 'start_work':
          if (!this.controls.startWork) throw new Error('startWork control is unavailable.');
          this.controls.startWork(command.workItemId, 'open');
          break;
        case 'stop_work':
          if (!this.controls.stopWork) throw new Error('stopWork control is unavailable.');
          this.controls.stopWork(command.workItemId, 'running');
          break;
        case 'complete_work':
          if (!this.controls.completeWork) throw new Error('completeWork control is unavailable.');
          this.controls.completeWork(command.workItemId, 'running');
          break;
        case 'reconcile_assignment':
          if (!this.controls.reconcileAssignment || !command.assignmentId || !command.outcome) {
            throw new Error('reconcileAssignment control is unavailable.');
          }
          this.controls.reconcileAssignment(
            command.workItemId,
            command.assignmentId,
            'running',
            command.outcome,
          );
          break;
        default:
          throw new Error('Organization command is not accepted.');
      }
      return Object.freeze({ command, outcome: 'dispatched' as const });
    } catch (cause) {
      return Object.freeze({ command, outcome: 'failed' as const, error: boundedError(cause) });
    }
  }
}

export type { OrganizationEvent };
