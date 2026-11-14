/*
 * #465 the time in column of the work board: per issue key, the current column and since when, in SQLite.
 * The table goes into the adapter's migration list (adapters/sqlite/migrations.ts) as migration 16,
 * additive: a new table. The same column keeps its `since`; a different one restarts it at the
 * observation's `at`.
 */

import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { immediateTransaction } from '../adapters/sqlite/immediate-transaction.ts';
import type { WorkColumnHistory, WorkColumnObservation } from './work-board.ts';

export const WORK_BOARD_MIGRATION_DESCRIPTION = 'work board: current column and since when per issue (#465)';

export const WORK_BOARD_MIGRATION_SQL = `
  CREATE TABLE work_board_columns (
    item_key TEXT NOT NULL PRIMARY KEY,
    column_id TEXT NOT NULL,
    since TEXT NOT NULL
  ) STRICT;
`;

export class SqliteWorkColumnHistory implements WorkColumnHistory {
  private readonly db: DatabaseSync;
  private readonly select: StatementSync;
  private readonly upsert: StatementSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    const ok = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'work_board_columns'").get();
    if (!ok) throw new Error('database without the work_board_columns table: open it with SqliteStorage, which applies the migrations');
    this.select = db.prepare('SELECT column_id, since FROM work_board_columns WHERE item_key = ?');
    this.upsert = db.prepare(
      'INSERT INTO work_board_columns (item_key, column_id, since) VALUES (?, ?, ?) ON CONFLICT (item_key) DO UPDATE SET column_id = excluded.column_id, since = excluded.since',
    );
  }

  async observe(observations: readonly WorkColumnObservation[]): Promise<Map<string, string>> {
    const since = new Map<string, string>();
    if (!observations.length) return since;
    immediateTransaction(this.db, () => {
      for (const { key, column, at } of observations) {
        const row = this.select.get(key) as { column_id: string; since: string } | undefined;
        if (row && row.column_id === column) {
          since.set(key, row.since);
          continue;
        }
        this.upsert.run(key, column, at);
        since.set(key, at);
      }
    });
    return since;
  }
}
