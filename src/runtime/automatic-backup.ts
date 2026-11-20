import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { backupFileName, rotateBackups } from './backup.js';

/**
 * Takes a database snapshot on a timer.
 *
 * The Runtime owns exactly one SQLite connection (`PRAGMA locking_mode =
 * EXCLUSIVE`), so a backup cannot open the file from outside. It must go through
 * that connection, which is what `store.backupTo` does.
 *
 * Three rules shape this module:
 *
 * 1. A failed backup must never propagate into the task loop. Disk-full and a
 *    missing directory are operational problems, not task failures.
 * 2. Overlapping runs are impossible. A slow snapshot must not queue up behind
 *    itself and produce a burst of identical files.
 * 3. Rotation is part of the same operation. A backup directory that grows
 *    without bound becomes its own problem.
 */

export interface AutomaticBackupStatus {
  /** Whether a snapshot is currently on a timer. */
  readonly running: boolean;
  readonly lastOk: boolean | null;
  readonly lastBackup: string | null;
  readonly lastError: string | null;
  readonly lastRunAt: string | null;
  /** How many snapshots have been attempted since construction. */
  readonly attempts: number;
}

export interface AutomaticBackupOptions {
  /** The live store; snapshots go through its connection. */
  readonly store: { backupTo(target: string): void };
  readonly directory: string;
  /** How many snapshots to keep. Values below 1 clamp to 1. */
  readonly keep: number;
  readonly intervalMs?: number;
  readonly clock?: () => string;
  /** Injected for tests and for the failure path. */
  readonly snapshot?: (target: string) => void;
}

export interface AutomaticBackup {
  start(): void;
  runOnce(): Promise<void>;
  stop(): Promise<void>;
  status(): AutomaticBackupStatus;
}

export const DEFAULT_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MIN_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export function createAutomaticBackup(options: AutomaticBackupOptions): AutomaticBackup {
  const clock = options.clock ?? (() => new Date().toISOString());
  const snapshot = options.snapshot ?? ((target: string) => options.store.backupTo(target));
  const keep = Math.max(1, Math.min(64, Math.trunc(options.keep)));
  const intervalMs = clampInterval(options.intervalMs ?? DEFAULT_BACKUP_INTERVAL_MS);

  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let inFlight: Promise<void> | null = null;
  let lastOk: boolean | null = null;
  let lastBackup: string | null = null;
  let lastError: string | null = null;
  let lastRunAt: string | null = null;
  let attempts = 0;

  async function runOnce(): Promise<void> {
    // Serialize: a tick that lands while the previous snapshot is still running
    // waits for it rather than starting a second one.
    if (inFlight) {
      await inFlight;
      return;
    }
    inFlight = (async () => {
      attempts += 1;
      lastRunAt = clock();
      try {
        mkdirSync(options.directory, { recursive: true });
        const target = path.join(options.directory, backupFileName(lastRunAt));
        snapshot(target);
        rotateBackups(options.directory, keep);
        lastBackup = target;
        lastError = null;
        lastOk = true;
      } catch (cause) {
        // Reported, never thrown: a backup failure must not look like a task
        // failure to whatever called `runOnce`.
        lastOk = false;
        lastError = cause instanceof Error ? cause.message.slice(0, 300) : 'backup failed';
      }
    })().finally(() => {
      inFlight = null;
    });
    await inFlight;
  }

  return Object.freeze({
    start() {
      if (timer || running) return;
      running = true;
      timer = setInterval(() => { void runOnce(); }, intervalMs);
      // A background timer must not keep the process alive on its own: shutdown
      // is the Runtime's decision, not a pending snapshot's.
      timer.unref?.();
    },
    runOnce,
    async stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      running = false;
      if (inFlight) await inFlight;
    },
    status(): AutomaticBackupStatus {
      return Object.freeze({
        running,
        lastOk,
        lastBackup,
        lastError,
        lastRunAt,
        attempts,
      });
    },
  });
}

function clampInterval(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_BACKUP_INTERVAL_MS;
  return Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, Math.trunc(value)));
}
