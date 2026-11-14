/*
 * #531 the execution runs of the work board in SQLite: the last run per issue key. The table goes into the
 * adapter's migration list (adapters/sqlite/migrations.ts) as migration 18, additive: a new table.
 */

import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { ExecutionRun, ExecutionRunState, ExecutionTarget, WorkExecutionRuns } from './work-execution.ts';

export const WORK_EXECUTION_MIGRATION_DESCRIPTION = 'work board: the last execution run per issue (#531)';

export const WORK_EXECUTION_MIGRATION_SQL = `
  CREATE TABLE work_execution_runs (
    item_key TEXT NOT NULL PRIMARY KEY,
    target TEXT NOT NULL,
    started_at TEXT NOT NULL,
    state TEXT NOT NULL,
    session_id TEXT,
    finished_at TEXT
  ) STRICT;
`;

interface Row {
  item_key: string;
  target: string;
  started_at: string;
  state: string;
  session_id: string | null;
  finished_at: string | null;
}

const toRun = (r: Row): ExecutionRun => ({
  key: r.item_key,
  target: r.target as ExecutionTarget,
  startedAt: r.started_at,
  state: r.state as ExecutionRunState,
  sessionId: r.session_id,
  finishedAt: r.finished_at,
});

export class SqliteWorkExecutionRuns implements WorkExecutionRuns {
  private readonly one: StatementSync;
  private readonly every: StatementSync;
  private readonly upsert: StatementSync;

  constructor(db: DatabaseSync) {
    const ok = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'work_execution_runs'").get();
    if (!ok) throw new Error('database without the work_execution_runs table: open it with SqliteStorage, which applies the migrations');
    this.one = db.prepare('SELECT * FROM work_execution_runs WHERE item_key = ?');
    this.every = db.prepare('SELECT * FROM work_execution_runs ORDER BY started_at');
    this.upsert = db.prepare(
      `INSERT INTO work_execution_runs (item_key, target, started_at, state, session_id, finished_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (item_key) DO UPDATE SET target = excluded.target, started_at = excluded.started_at, state = excluded.state,
         session_id = excluded.session_id, finished_at = excluded.finished_at`,
    );
  }

  async get(key: string): Promise<ExecutionRun | null> {
    const row = this.one.get(key.toLowerCase()) as Row | undefined;
    return row ? toRun(row) : null;
  }

  async all(): Promise<ExecutionRun[]> {
    return (this.every.all() as unknown as Row[]).map(toRun);
  }

  async save(run: ExecutionRun): Promise<void> {
    this.upsert.run(run.key.toLowerCase(), run.target, run.startedAt, run.state, run.sessionId, run.finishedAt);
  }
}
