/*
 * #507 the planning runs of the work board in SQLite: the last run per issue key. The table goes into the
 * adapter's migration list (adapters/sqlite/migrations.ts) as migration 17, additive: a new table.
 */

import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { PlanFailure, PlanRun, PlanRunOutcome, PlanTarget, WorkPlanRuns } from './work-plan.ts';

export const WORK_PLAN_MIGRATION_DESCRIPTION = 'work board: the last planning run per issue (#507)';

export const WORK_PLAN_MIGRATION_SQL = `
  CREATE TABLE work_plan_runs (
    item_key TEXT NOT NULL PRIMARY KEY,
    target TEXT NOT NULL,
    started_at TEXT NOT NULL,
    replan INTEGER NOT NULL,
    session_id TEXT,
    outcome TEXT NOT NULL,
    failure TEXT,
    finished_at TEXT
  ) STRICT;
`;

interface Row {
  item_key: string;
  target: string;
  started_at: string;
  replan: number;
  session_id: string | null;
  outcome: string;
  failure: string | null;
  finished_at: string | null;
}

const toRun = (r: Row): PlanRun => ({
  key: r.item_key,
  target: r.target as PlanTarget,
  startedAt: r.started_at,
  replan: r.replan === 1,
  sessionId: r.session_id,
  outcome: r.outcome as PlanRunOutcome,
  failure: r.failure as PlanFailure | null,
  finishedAt: r.finished_at,
});

export class SqliteWorkPlanRuns implements WorkPlanRuns {
  private readonly one: StatementSync;
  private readonly every: StatementSync;
  private readonly upsert: StatementSync;

  constructor(db: DatabaseSync) {
    const ok = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'work_plan_runs'").get();
    if (!ok) throw new Error('database without the work_plan_runs table: open it with SqliteStorage, which applies the migrations');
    this.one = db.prepare('SELECT * FROM work_plan_runs WHERE item_key = ?');
    this.every = db.prepare('SELECT * FROM work_plan_runs ORDER BY started_at');
    this.upsert = db.prepare(
      `INSERT INTO work_plan_runs (item_key, target, started_at, replan, session_id, outcome, failure, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (item_key) DO UPDATE SET target = excluded.target, started_at = excluded.started_at, replan = excluded.replan,
         session_id = excluded.session_id, outcome = excluded.outcome, failure = excluded.failure, finished_at = excluded.finished_at`,
    );
  }

  async get(key: string): Promise<PlanRun | null> {
    const row = this.one.get(key.toLowerCase()) as Row | undefined;
    return row ? toRun(row) : null;
  }

  async all(): Promise<PlanRun[]> {
    return (this.every.all() as unknown as Row[]).map(toRun);
  }

  async save(run: PlanRun): Promise<void> {
    this.upsert.run(run.key.toLowerCase(), run.target, run.startedAt, run.replan ? 1 : 0, run.sessionId, run.outcome, run.failure, run.finishedAt);
  }
}
