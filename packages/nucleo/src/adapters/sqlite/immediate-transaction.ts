import type { DatabaseSync } from 'node:sqlite';

/** Runs `fn` in one BEGIN IMMEDIATE transaction: commit on return, rollback and rethrow on error. Does not nest. */
export function immediateTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
