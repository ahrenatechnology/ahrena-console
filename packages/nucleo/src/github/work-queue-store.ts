/*
 * #477 the execution queue of the work board in SQLite: one row per queued issue key, `position` 1-based
 * and contiguous. The table goes into the adapter's migration list (adapters/sqlite/migrations.ts) as
 * migration 19, additive: a new table. Every write is one `BEGIN IMMEDIATE` transaction that reads the
 * order, changes it and writes it back whole, so two writers never leave a gap or a repeated position.
 */

import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { immediateTransaction } from '../adapters/sqlite/immediate-transaction.ts';
import type { ExecutionTarget } from './work-execution.ts';
import { moveAfter, stopOf, type QueueEntry, type QueueStop, type WorkQueueStore } from './work-queue.ts';

export const WORK_QUEUE_MIGRATION_DESCRIPTION = 'work board: the execution queue (#477)';

export const WORK_QUEUE_MIGRATION_SQL = `
  CREATE TABLE work_queue (
    item_key TEXT NOT NULL PRIMARY KEY,
    position INTEGER NOT NULL,
    target TEXT NOT NULL,
    enqueued_at TEXT NOT NULL,
    failed_reason TEXT,
    failed_at TEXT
  ) STRICT;
`;

interface Row {
  item_key: string;
  position: number;
  target: string;
  enqueued_at: string;
  failed_reason: string | null;
  failed_at: string | null;
}

const toEntry = (r: Row): QueueEntry => ({
  key: r.item_key,
  position: r.position,
  target: r.target as ExecutionTarget,
  enqueuedAt: r.enqueued_at,
  failedReason: r.failed_reason,
  failedAt: r.failed_at,
});

export class SqliteWorkQueue implements WorkQueueStore {
  readonly available = true;
  private readonly db: DatabaseSync;
  private readonly every: StatementSync;
  private readonly insert: StatementSync;
  private readonly retarget: StatementSync;
  private readonly delete: StatementSync;
  private readonly place: StatementSync;
  private readonly fail: StatementSync;

  constructor(db: DatabaseSync) {
    const ok = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'work_queue'").get();
    if (!ok) throw new Error('database without the work_queue table: open it with SqliteStorage, which applies the migrations');
    this.db = db;
    this.every = db.prepare('SELECT * FROM work_queue ORDER BY position');
    this.insert = db.prepare('INSERT INTO work_queue (item_key, position, target, enqueued_at, failed_reason, failed_at) VALUES (?, ?, ?, ?, NULL, NULL)');
    this.retarget = db.prepare('UPDATE work_queue SET target = ? WHERE item_key = ?');
    this.delete = db.prepare('DELETE FROM work_queue WHERE item_key = ?');
    this.place = db.prepare('UPDATE work_queue SET position = ? WHERE item_key = ?');
    this.fail = db.prepare('UPDATE work_queue SET failed_reason = ?, failed_at = ? WHERE item_key = ?');
  }

  private rows(): Row[] {
    return this.every.all() as unknown as Row[];
  }

  /** Writes the order `keys` as positions 1..n. */
  private renumber(keys: readonly string[]): void {
    keys.forEach((key, i) => this.place.run(i + 1, key));
  }

  async list(): Promise<QueueEntry[]> {
    return this.rows().map(toEntry);
  }

  async positions(): Promise<ReadonlyMap<string, number>> {
    return new Map(this.rows().map((r) => [r.item_key, r.position]));
  }

  async stopped(): Promise<QueueStop | null> {
    return stopOf(this.rows().map(toEntry));
  }

  async enqueue(key: string, target: ExecutionTarget, at: string): Promise<QueueEntry> {
    const k = key.toLowerCase();
    return immediateTransaction(this.db, () => {
      const rows = this.rows();
      if (rows.some((r) => r.item_key === k)) this.retarget.run(target, k);
      else this.insert.run(k, rows.length + 1, target, at);
      return toEntry(this.rows().find((r) => r.item_key === k)!);
    });
  }

  async remove(key: string): Promise<boolean> {
    const k = key.toLowerCase();
    return immediateTransaction(this.db, () => {
      const keys = this.rows().map((r) => r.item_key);
      if (!keys.includes(k)) return false;
      this.delete.run(k);
      this.renumber(keys.filter((x) => x !== k));
      return true;
    });
  }

  async reorder(key: string, after: string | null): Promise<boolean> {
    const k = key.toLowerCase();
    const anchor = after === null ? null : after.toLowerCase();
    return immediateTransaction(this.db, () => {
      const moved = moveAfter(this.rows().map((r) => r.item_key), k, anchor);
      if (!moved) return false;
      this.renumber(moved);
      return true;
    });
  }

  async markFailed(key: string, reason: string, at: string): Promise<boolean> {
    const k = key.toLowerCase();
    return immediateTransaction(this.db, () => {
      const moved = moveAfter(this.rows().map((r) => r.item_key), k, null);
      if (!moved) return false;
      this.fail.run(reason, at, k);
      this.renumber(moved);
      return true;
    });
  }
}
