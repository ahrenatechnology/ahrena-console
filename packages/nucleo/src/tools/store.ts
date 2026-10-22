// The cache of the Tools checks (#280, decision 0014 section 2): table `tool_checks` in the núcleo's
// database (migration.ts), valid for 6 h. The screen opens with it and its time; Verificar agora
// replaces it. Uses the same database as the storage adapter (`SqliteStorage.db`), which has already
// applied the migration.

import type { DatabaseSync, StatementSync } from 'node:sqlite';

export const CHECK_VALIDITY_MS = 6 * 60 * 60 * 1000;

export interface ToolCheck {
  toolId: string;
  sourceId: string | null;
  installed: string | null;
  latest: string | null;
  /** Epoch ms. */
  checkedAt: number;
  error: string | null;
}

export interface ToolChecksStore {
  list(machineId: string): ToolCheck[];
  /** Replaces every row of the machine, in one transaction. */
  replace(machineId: string, checks: readonly ToolCheck[]): void;
}

/** The checks still valid at `now`. */
export function validChecks(checks: readonly ToolCheck[], now: number, validityMs = CHECK_VALIDITY_MS): ToolCheck[] {
  return checks.filter((c) => c.checkedAt <= now && now - c.checkedAt < validityMs);
}

export class MemoryToolChecksStore implements ToolChecksStore {
  private readonly rows = new Map<string, ToolCheck[]>();
  list(machineId: string): ToolCheck[] {
    return (this.rows.get(machineId) ?? []).map((c) => ({ ...c }));
  }
  replace(machineId: string, checks: readonly ToolCheck[]): void {
    this.rows.set(machineId, checks.map((c) => ({ ...c })));
  }
}

type Row = Record<string, unknown>;

export class SqliteToolChecksStore implements ToolChecksStore {
  private readonly db: DatabaseSync;
  private readonly select: StatementSync;
  private readonly insert: StatementSync;
  private readonly clear: StatementSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    const ok = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tool_checks'").get();
    if (!ok) throw new Error('database without the tool_checks table: open it with SqliteStorage, which applies the migrations');
    this.select = db.prepare('SELECT tool_id, source_id, installed, latest, checked_at, error FROM tool_checks WHERE machine_id = ? ORDER BY tool_id');
    this.insert = db.prepare('INSERT INTO tool_checks (machine_id, tool_id, source_id, installed, latest, checked_at, error) VALUES (?, ?, ?, ?, ?, ?, ?)');
    this.clear = db.prepare('DELETE FROM tool_checks WHERE machine_id = ?');
  }

  list(machineId: string): ToolCheck[] {
    return (this.select.all(machineId) as Row[]).map((r) => ({
      toolId: r.tool_id as string,
      sourceId: r.source_id as string | null,
      installed: r.installed as string | null,
      latest: r.latest as string | null,
      checkedAt: r.checked_at as number,
      error: r.error as string | null,
    }));
  }

  replace(machineId: string, checks: readonly ToolCheck[]): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.clear.run(machineId);
      for (const c of checks) this.insert.run(machineId, c.toolId, c.sourceId, c.installed, c.latest, Math.floor(c.checkedAt), c.error);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}
