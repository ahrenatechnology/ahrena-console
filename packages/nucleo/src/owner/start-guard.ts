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

/**
 * Moves the stale guard (held by `stale`, a dead pid, or `null` for an unreadable one) out of the
 * way. If what it moved is not that guard (another start recovered it and created its own in
 * between), it goes back in place: it keeps trying until it is back, so a live guard is never lost.
 */
async function clearIfStale(dir: string, stale: number | null): Promise<void> {
  const moved = tempPath(dir, 'old');
  try {
    renameSync(guardPath(dir), moved);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  const pid = holderOf(moved);
  const wasTheStaleOne = pid === stale || pid === null || !isPidAlive(pid);
  for (let attempt = 0; !wasTheStaleOne; attempt++) {
    try {
      linkSync(moved, guardPath(dir));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      // Someone created a guard meanwhile: wait for it to go, then put the live one back.
      if (attempt > 600) throw new Error(`could not put back the start guard of pid ${pid}`);
      await sleep(100);
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
      await clearIfStale(dir, pid);
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
