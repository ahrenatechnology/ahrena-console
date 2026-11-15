// What the OLTP tests share (#618, layer 3): a real SQLite file with the migrations applied, and requests in every state.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { migrate } from '../../src/adapters/sqlite/migrations.ts';
import { EXPIRY_MS, PermissionRequest } from '../../src/permissions/model.ts';
import { T0 } from './fakes.ts';

/** A temporary folder removed when the file's tests end. (#618) */
export function tempDir(prefix = 'perm-oltp-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** One connection to the database file, migrated. A second call with the same file is a second connection. (#618) */
export function openDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  after(() => {
    if (db.isOpen) db.close();
  });
  return db;
}

export const SECRET_COMMAND = 'DATABASE_URL=postgres://u:hunter2pw@h/db npm run migrate';

export interface OpenOver {
  id?: string;
  sessionId?: string;
  toolName?: string;
  toolInput?: unknown;
  permissionMode?: string | null;
  now?: number;
}

export const openRequest = (over: OpenOver = {}): Promise<PermissionRequest> =>
  PermissionRequest.open({
    id: over.id ?? 'rq-1',
    sessionId: over.sessionId ?? 'S1',
    toolName: over.toolName ?? 'Bash',
    toolInput: 'toolInput' in over ? over.toolInput : { command: 'npm run migrate' },
    cwd: '/w',
    permissionMode: 'permissionMode' in over ? (over.permissionMode ?? null) : 'default',
    now: over.now ?? T0,
  });

export const answerWith = (r: PermissionRequest, decision: 'allow' | 'deny' = 'deny', reason = 'not now', now = T0 + 1_000): PermissionRequest => {
  r.answer({ decision, ...(decision === 'deny' ? { reason } : {}), answeredBy: 'owner', channel: 'ui', now });
  return r;
};

/** Every field the aggregate exposes, as plain data, to compare a request with the one read back. (#618) */
export const snapshot = (r: PermissionRequest): Record<string, unknown> => ({
  id: r.id, sessionId: r.sessionId, toolName: r.toolName, digest: r.digest, summary: r.summary, summaryTruncated: r.summaryTruncated,
  cwd: r.cwd, permissionMode: r.permissionMode, terminalOnly: r.terminalOnly, createdAt: r.createdAt, expiresAt: r.expiresAt,
  state: r.state, decision: r.decision, reason: r.reason, answeredBy: r.answeredBy, channel: r.channel,
  answeredAt: r.answeredAt, settledAt: r.settledAt, settledBy: r.settledBy,
});

/** One request in each state of the life. (#618) */
export async function requestsInEveryState(): Promise<PermissionRequest[]> {
  const make = (n: number) => openRequest({ id: `rq-${n}`, now: T0 + n });
  const [pending, answered, delivered, expired, withdrawn, elsewhere, restarted] = await Promise.all([1, 2, 3, 4, 5, 6, 7].map(make));
  answerWith(answered!);
  answerWith(delivered!, 'allow').deliver(T0 + 2_000);
  expired!.expire(T0 + 4 + EXPIRY_MS);
  withdrawn!.withdraw(T0 + 2_000);
  elsewhere!.closeElsewhere(T0 + 2_000);
  restarted!.closeAfterRestart(T0 + 2_000);
  return [pending!, answered!, delivered!, expired!, withdrawn!, elsewhere!, restarted!];
}

/** The lines of a JSON Lines file, each narrowed to an object. (#618) */
export function readJsonLines(file: string): Record<string, unknown>[] {
  return readFileSync(file, 'utf8').trim().split('\n').map((line) => {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== 'object' || parsed === null) throw new Error('a line is not an object');
    return { ...parsed };
  });
}
