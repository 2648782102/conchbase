/**
 * Fires due schedules.
 *
 * Kept separate from the store so the firing policy is testable without a clock
 * or a database, and separate from `TaskService` so a schedule can only do what
 * a user could do by hand: create an Agent task and start it.
 *
 * Two failure rules:
 *
 * - a schedule whose task cannot be created is disabled after the failure is
 *   recorded, because retrying every tick against a deleted Agent would spam the
 *   event log and never succeed;
 * - a schedule is never fired while its own previous task is still running.
 *   Overlapping runs of the same recurring job do not make it faster, they make
 *   its results ambiguous.
 */
import {
  isDue,
  nextRunAfter,
  type Schedule,
  type ScheduleStore,
} from './schedule.js';
import type { TaskService } from './task-service.js';

export interface ScheduleRunnerOptions {
  readonly store: ScheduleStore;
  readonly taskService: TaskService;
  readonly now?: () => string;
  /** How often to look for due schedules. */
  readonly tickMs?: number;
}

export interface ScheduleRunResult {
  readonly scheduleId: string;
  readonly outcome: 'created' | 'skipped' | 'failed';
  readonly taskId?: string;
  readonly detail?: string;
}

export interface ScheduleRunner {
  start(): void;
  stop(): void;
  /** Runs one pass immediately. Exposed for tests and for `conchbase schedules`. */
  runOnce(): Promise<readonly ScheduleRunResult[]>;
}

const DEFAULT_TICK_MS = 30_000;

export function createScheduleRunner(options: ScheduleRunnerOptions): ScheduleRunner {
  const now = options.now ?? (() => new Date().toISOString());
  const tickMs = Math.max(1_000, options.tickMs ?? DEFAULT_TICK_MS);
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<readonly ScheduleRunResult[]> | null = null;

  async function fire(schedule: Schedule, at: string): Promise<ScheduleRunResult> {
    /*
     * Skip rather than queue when the previous run is still going.
     *
     * The scheduled moment is moved forward regardless, so one long run delays
     * the cadence instead of building a backlog of identical jobs.
     */
    if (schedule.lastTaskId) {
      const previous = options.taskService.store.getTask(schedule.lastTaskId);
      if (previous && !['succeeded', 'failed', 'cancelled', 'interrupted'].includes(previous.state)) {
        options.store.update(schedule.id, { nextRunAt: nextRunAfter(schedule, at) });
        return Object.freeze({ scheduleId: schedule.id, outcome: 'skipped', detail: 'previous run still active' });
      }
    }

    try {
      const task = await options.taskService.createAgentTask({
        prompt: schedule.prompt,
        agentId: schedule.agentId,
      });
      options.store.update(schedule.id, {
        lastRunAt: at,
        lastTaskId: task.id,
        nextRunAt: nextRunAfter(schedule, at),
      });
      options.taskService.startTask(task.id);
      return Object.freeze({ scheduleId: schedule.id, outcome: 'created', taskId: task.id });
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200) : 'schedule failed';
      /*
       * Disable, do not retry forever.
       *
       * The common causes — the Agent was archived, its model was removed from
       * the catalog — are permanent until a person acts. Retrying every tick
       * would write one event per tick and never succeed.
       */
      options.store.update(schedule.id, { enabled: false, nextRunAt: nextRunAfter(schedule, at), lastRunAt: at });
      return Object.freeze({ scheduleId: schedule.id, outcome: 'failed', detail });
    }
  }

  async function runOnce(): Promise<readonly ScheduleRunResult[]> {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const at = now();
      const due = options.store.list().filter((schedule) => isDue(schedule, at));
      const results: ScheduleRunResult[] = [];
      for (const schedule of due) results.push(await fire(schedule, at));
      return Object.freeze(results);
    })().finally(() => { inFlight = null; });
    return inFlight;
  }

  return Object.freeze({
    start() {
      if (timer) return;
      timer = setInterval(() => { void runOnce(); }, tickMs);
      // Like the backup timer: a pending tick must not keep the process alive.
      timer.unref?.();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    runOnce,
  });
}
