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
import type { OrganizationStore } from './organization-store.js';

export const ORGANIZATION_COORDINATOR_CONTRACT_VERSION = 1;

export interface OrganizationControlResult {
  readonly command: OrganizationCommand;
  readonly outcome: 'dispatched' | 'failed';
  readonly error?: string;
}

export interface OrganizationCoordinatorResult {
  readonly version: typeof ORGANIZATION_COORDINATOR_CONTRACT_VERSION;
  readonly snapshot: OrganizationSnapshot;
  readonly executions: readonly OrganizationControlResult[];
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
  ) {}

  submitAction(input: unknown): OrganizationCoordinatorResult {
    this.store.apply(input);
    return this.reconcile();
  }

  reconcile(): OrganizationCoordinatorResult {
    const snapshot = this.store.get();
    const plan = planOrganizationExecution(snapshot, this.controls.listWorkState(), this.limits);
    const dispatched = new Set<string>();
    const executions: OrganizationControlResult[] = [];
    for (const command of plan.commands) {
      const key = commandKey(command);
      if (dispatched.has(key)) continue;
      dispatched.add(key);
      executions.push(this.dispatch(command));
    }
    return Object.freeze({
      version: ORGANIZATION_COORDINATOR_CONTRACT_VERSION,
      snapshot,
      executions: Object.freeze(executions),
      relays: plan.relays,
    });
  }

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

export function organizationRelayEvents(relays: readonly OrganizationRelay[]): readonly OrganizationRelay[] {
  return Object.freeze([...relays].sort((left, right) => left.sequence - right.sequence));
}

export type { OrganizationEvent };
