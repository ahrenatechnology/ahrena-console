// What the permission use cases get at the core's start (#618, layer 3): the SQLite repository on the core's database, the
// audit file in its data folder, the system clock, an in-process change notifier and random ids.
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { PermissionDeps } from '../ports.ts';
import { PermissionAuditFile } from './audit-file.ts';
import { InProcessChangeNotifier } from './change-notifier.ts';
import { SqlitePermissionRepository } from './sqlite-repository.ts';
import { SystemClock } from './system-clock.ts';

export function openPermissionDeps(db: DatabaseSync, dataDir: string, log: (message: string) => void = () => {}): PermissionDeps {
  return {
    repository: new SqlitePermissionRepository(db),
    audit: new PermissionAuditFile(dataDir, log),
    clock: new SystemClock(),
    notifier: new InProcessChangeNotifier(),
    newId: randomUUID,
  };
}
