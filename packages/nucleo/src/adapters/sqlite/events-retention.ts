// Retention of the `events` table (#708, part 3 of #705) and the compaction of the file after it.
//
// - Events older than a window (default 30 days, the same as Claude Code's `cleanupPeriodDays` for the
//   transcripts, so the console keeps no event whose source is gone) are deleted in small batches: one
//   short transaction per batch, with a pause between batches so the core's event loop (hooks, API,
//   follower) is never held for more than a batch.
// - It never runs in the startup path: `startEventsRetention` is called after the initial history import
//   and then ticks once a day.
// - After a large delete the freed pages go back to the file with `PRAGMA incremental_vacuum(N)`, in steps,
//   when the database is in `auto_vacuum = INCREMENTAL` mode (new databases are born in it). A database
//   created before this change is in NONE mode: switching mode needs one full VACUUM, which holds the
//   whole file locked and rewrites it, so it only runs on an explicit opt-in (`AHRENA_CONSOLE_EVENTS_FULL_VACUUM=1`).
//   Without it the freed pages stay on the freelist and are reused by new events: the file stops growing
//   but does not shrink.
// - The row holding the highest `seq` is never deleted: `seq` is `MAX(seq) + 1`, and the followers of the
//   event feed hold a `seq` cursor, so it must never restart lower.
// - Sessions, token_usage (with its baseline floor) and every other table are untouched. A transcript the
//   importer reads again from byte 0 brings old events back and the next run deletes them again.

import type { DatabaseSync } from 'node:sqlite';

export const DEFAULT_EVENTS_RETENTION_DAYS = 30;
export const MAX_EVENTS_RETENTION_DAYS = 3650;
const DAY_MS = 86_400_000;
const AUTO_VACUUM_INCREMENTAL = 2;

export interface EventsRetentionOptions {
  /** Events with `created_at` strictly older than now minus this many days are deleted. */
  days: number;
  now?: () => number;
  /** Rows per delete transaction. */
  batchSize?: number;
  /** Least pause between batches, so other work on the event loop runs. */
  pauseMs?: number;
  /** The pause is at least this many times the time the batch took: the work stays under 1 / (1 + factor) of a core. */
  pauseFactor?: number;
  /** Deleted rows from which the file is compacted. */
  compactThreshold?: number;
  /** Pages freed per `incremental_vacuum` step. */
  vacuumPages?: number;
  /** One full VACUUM to switch an existing database to incremental mode (opt-in). */
  fullVacuum?: boolean;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export interface EventsRetentionResult {
  cutoff: string;
  deleted: number;
  batches: number;
  compaction: 'none' | 'incremental' | 'full' | 'unavailable';
  vacuumSteps: number;
}

/** The window from the environment: a whole number of days from 1 to 3650, else the default (with a warning). */
export function parseEventsRetentionDays(raw: string | undefined): { days: number; warning?: string } {
  if (raw === undefined || raw.trim() === '') return { days: DEFAULT_EVENTS_RETENTION_DAYS };
  const n = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || n < 1 || n > MAX_EVENTS_RETENTION_DAYS) {
    return {
      days: DEFAULT_EVENTS_RETENTION_DAYS,
      warning: `AHRENA_CONSOLE_EVENTS_RETENTION_DAYS=${JSON.stringify(raw)} is not a whole number of days from 1 to ${MAX_EVENTS_RETENTION_DAYS}; using ${DEFAULT_EVENTS_RETENTION_DAYS}`,
    };
  }
  return { days: n };
}

/** Deletes up to `limit` events older than `cutoff` (oldest first). Returns how many went. */
export function pruneEventsBatch(db: DatabaseSync, cutoff: string, limit: number): number {
  const result = db
    .prepare(
      `DELETE FROM events WHERE rowid IN (
         SELECT rowid FROM events
         WHERE created_at < ? AND seq < (SELECT MAX(seq) FROM events)
         ORDER BY created_at LIMIT ?)`,
    )
    .run(cutoff, limit);
  return Number(result.changes);
}

function pragmaNumber(db: DatabaseSync, name: string): number {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, number> | undefined;
  return row ? Number(Object.values(row)[0]) : 0;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runEventsRetention(db: DatabaseSync, options: EventsRetentionOptions): Promise<EventsRetentionResult> {
  const now = options.now ?? Date.now;
  const batchSize = options.batchSize ?? 500;
  const pauseMs = options.pauseMs ?? 100;
  const pauseFactor = options.pauseFactor ?? 4;
  const compactThreshold = options.compactThreshold ?? 50_000;
  const vacuumPages = options.vacuumPages ?? 250;
  const sleep = options.sleep ?? realSleep;
  const cutoff = new Date(now() - options.days * DAY_MS).toISOString();

  let deleted = 0;
  let batches = 0;
  for (;;) {
    const t0 = performance.now();
    const n = pruneEventsBatch(db, cutoff, batchSize);
    if (n === 0) break;
    deleted += n;
    batches++;
    if (n < batchSize) break;
    await sleep(Math.max(pauseMs, (performance.now() - t0) * pauseFactor));
  }

  const result: EventsRetentionResult = { cutoff, deleted, batches, compaction: 'none', vacuumSteps: 0 };
  const incremental = pragmaNumber(db, 'auto_vacuum') === AUTO_VACUUM_INCREMENTAL;

  if (!incremental && options.fullVacuum) {
    // One time per database: the mode only changes with a VACUUM. Holds the file locked while it runs.
    options.log?.('events retention: switching the database to incremental auto_vacuum with one full VACUUM');
    db.exec('PRAGMA auto_vacuum = INCREMENTAL');
    db.exec('VACUUM');
    result.compaction = 'full';
    return result;
  }

  if (deleted >= compactThreshold) {
    if (!incremental) {
      result.compaction = 'unavailable';
    } else {
      result.compaction = 'incremental';
      while (pragmaNumber(db, 'freelist_count') > 0) {
        const t0 = performance.now();
        db.exec(`PRAGMA incremental_vacuum(${Math.trunc(vacuumPages)})`);
        result.vacuumSteps++;
        await sleep(Math.max(pauseMs, (performance.now() - t0) * pauseFactor));
      }
    }
    // Keeps the WAL from carrying the delete forever; never blocks the core's writers.
    db.exec('PRAGMA wal_checkpoint(PASSIVE)');
  }
  return result;
}

export interface EventsRetentionSchedule {
  db: DatabaseSync;
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  /** Wait before the first run, after the initial import. Default 60 s. */
  firstDelayMs?: number;
  /** Between runs. Default one day. */
  intervalMs?: number;
}

/** The first run after the initial history import, then daily. Returns the stop function. */
export function startEventsRetention(schedule: EventsRetentionSchedule): () => void {
  const parsed = parseEventsRetentionDays(schedule.env.AHRENA_CONSOLE_EVENTS_RETENTION_DAYS);
  if (parsed.warning) schedule.log(parsed.warning);
  const fullVacuum = schedule.env.AHRENA_CONSOLE_EVENTS_FULL_VACUUM === '1';
  let running = false;
  let stopped = false;

  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const started = Date.now();
      const r = await runEventsRetention(schedule.db, { days: parsed.days, fullVacuum, log: schedule.log });
      if (r.deleted > 0 || r.compaction !== 'none') {
        schedule.log(`events retention: ${r.deleted} events older than ${parsed.days} days deleted in ${r.batches} batches, compaction ${r.compaction} (${r.vacuumSteps} steps), ${Date.now() - started} ms`);
      }
    } catch (e) {
      schedule.log(`events retention failed: ${(e as Error).message}`);
    } finally {
      running = false;
    }
  };

  const first = setTimeout(() => void tick(), schedule.firstDelayMs ?? 60_000);
  const every = setInterval(() => void tick(), schedule.intervalMs ?? DAY_MS);
  first.unref();
  every.unref();
  return () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(every);
  };
}
