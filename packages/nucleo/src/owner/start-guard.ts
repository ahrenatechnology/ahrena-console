// The start guard of a data folder (issue #221). With a fixed port, the port itself says who opens
// the database: the system gives it to one start, and the others adopt (probe.ts, `reservePort`).
// With port 0 every start gets its own port, so that no longer serializes two starts of the same
// installation. This guard does: `core.starting` in the data folder, created exclusively by the
// start that will open the database, deleted once its lock is written (or on exit). Whoever finds
// it waits, then looks at the lock again, and adopts the core that just started.

import { randomBytes } from 'node:crypto';
import { linkSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { prepareDir } from './lock.ts';
import { isPidAlive, sleep } from './probe.ts';

export const START_GUARD_FILE_NAME = 'core.starting';

export interface StartGuard {
  /** `true` if another start held the guard first, so the caller should look at the lock again. */
  waited: boolean;
  /** Deletes the guard if it is still this process's. Safe to call more than once. */
  release: () => void;
}

const guardPath = (dir: string) => join(dir, START_GUARD_FILE_NAME);
const tempPath = (dir: string, label: string) => join(dir, `.${START_GUARD_FILE_NAME}.${label}.${process.pid}.${randomBytes(4).toString('hex')}`);

function holderOf(file: string): number | null {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as { pid?: unknown };
    return typeof v.pid === 'number' && Number.isInteger(v.pid) && v.pid > 0 ? v.pid : null;
  } catch {
    return null;
  }
}

/** Creates the guard only if there is none (written to a temporary file, then `link`). */
function tryCreate(dir: string): boolean {
  const tmp = tempPath(dir, 'new');
  writeFileSync(tmp, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, { mode: 0o600, flag: 'wx' });
  try {
    linkSync(tmp, guardPath(dir));
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Moves a stale guard (dead or unreadable holder) out of the way; a live one goes back in place. */
function clearIfStale(dir: string): void {
  const moved = tempPath(dir, 'old');
  try {
    renameSync(guardPath(dir), moved);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  const pid = holderOf(moved);
  if (pid !== null && isPidAlive(pid)) {
    try {
      linkSync(moved, guardPath(dir));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
  rmSync(moved, { force: true });
}

/**
 * Takes the guard of `dir`, waiting while another live start holds it. Throws if it is still held
 * after `timeoutMs` (default 60 s).
 */
export async function acquireStartGuard(dir: string, o: { timeoutMs?: number } = {}): Promise<StartGuard> {
  prepareDir(dir);
  const end = Date.now() + (o.timeoutMs ?? 60_000);
  let waited = false;
  for (;;) {
    if (tryCreate(dir)) break;
    const pid = holderOf(guardPath(dir));
    if (pid === null || !isPidAlive(pid)) {
      clearIfStale(dir);
      continue;
    }
    waited = true;
    if (Date.now() > end) throw new Error(`another start of this data folder (pid ${pid}) did not finish in time`);
    await sleep(100);
  }
  let held = true;
  return {
    waited,
    release: () => {
      if (!held) return;
      held = false;
      if (holderOf(guardPath(dir)) === process.pid) rmSync(guardPath(dir), { force: true });
    },
  };
}
