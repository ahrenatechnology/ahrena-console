// The core's lock: `nucleo.json` in the installation's data folder (`~/.ahrena-console` for `dev`,
// decision 0010), with pid, port, version, start time and a token for local clients (decision 0005,
// item 4). Atomic write (temporary file and `rename`), readable
// only by the owner (0600). The core writes it, once the port is already its own.
//
// The file has English keys (`port`, `version`, `startedAt`, `parent`, #274). Cores published before
// #274 wrote and read Portuguese ones (`porta`, `versao`, `inicio`, `pai`), and during an app or mod
// update one of them can still be up in the same folder. So, while the two generations coexist:
//   - the core writes both sets of keys, so an older core still recognises the lock;
//   - the core reads either set, English first, so it recognises a lock an older core wrote.
// When the legacy keys go: once no published app and mod writes them. The first app (0.0.7) and mod
// (0.0.36) that read English keys are the cutoff; the release after them (app 0.0.8, mod 0.0.37) drops
// `LEGACY_KEYS` from `toFile` and `readLockFile`. Recorded in decision 0009, "Migração".
// `Lock` is the in-memory shape; `toFile` and `readLockFile` map the two.

import { randomBytes } from 'node:crypto';
import { chmodSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { consoleHome } from './installation.ts';

export interface Lock {
  pid: number;
  port: number;
  version: string;
  /** ISO 8601. */
  startedAt: string;
  /** Random, so local clients can prove they read the lock. Never goes to a log or to `status`. */
  token: string;
  /** The process given in `--parent`, if any. */
  parent: number | null;
}

/** The lock as it is on disk. The `LEGACY_KEYS` are written only for cores older than #274. */
interface LockFile {
  pid: number;
  port: number;
  version: string;
  startedAt: string;
  token: string;
  parent: number | null;
  /** @deprecated legacy key, see the header. */
  porta?: number;
  /** @deprecated legacy key, see the header. */
  versao?: string;
  /** @deprecated legacy key, see the header. */
  inicio?: string;
  /** @deprecated legacy key, see the header. */
  pai?: number | null;
}

const toFile = (l: Lock): LockFile => ({
  pid: l.pid,
  port: l.port,
  version: l.version,
  startedAt: l.startedAt,
  token: l.token,
  parent: l.parent,
  // LEGACY_KEYS
  porta: l.port,
  versao: l.version,
  inicio: l.startedAt,
  pai: l.parent,
});

export const LOCK_FILE_NAME = 'nucleo.json';

/**
 * The `dev` installation's data folder, `~/.ahrena-console` (or `AHRENA_CONSOLE_HOME`): the default
 * for every function here. Another installation passes its own (installation.ts, `resolveDataDir`).
 */
export function defaultDir(): string {
  return consoleHome();
}

export function lockFilePath(dir = defaultDir()): string {
  return join(dir, LOCK_FILE_NAME);
}

export function newToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Creates the folder with 0700 and, if it already existed more open (the `mkdir` before #86 gave
 * 0755), closes it. The database lives in it: with the folder closed, no other user reaches SQLite.
 */
export function prepareDir(dir = defaultDir()): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

const isPositiveInt = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v > 0;

/** The lock, `null` if there is none, or `'invalid'` if the file is not a lock (counts as orphan). */
export function readLock(dir = defaultDir()): Lock | 'invalid' | null {
  return readLockFile(lockFilePath(dir));
}

function readLockFile(file: string): Lock | 'invalid' | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  try {
    const t = JSON.parse(text) as Partial<LockFile>;
    // English keys first; LEGACY_KEYS fill in what an older core wrote.
    const port = t.port ?? t.porta;
    const version = t.version ?? t.versao;
    const startedAt = t.startedAt ?? t.inicio;
    const parent = t.parent ?? t.pai;
    if (!isPositiveInt(t.pid) || !isPositiveInt(port) || typeof version !== 'string' || typeof startedAt !== 'string' || typeof t.token !== 'string') {
      return 'invalid';
    }
    return { pid: t.pid!, port: port!, version, startedAt, token: t.token, parent: isPositiveInt(parent) ? parent! : null };
  } catch {
    return 'invalid';
  }
}

const tempPath = (dir: string, label: string) => join(dir, `.${LOCK_FILE_NAME}.${label}.${process.pid}.${randomBytes(4).toString('hex')}`);

function writeTemp(lock: Lock, dir: string): string {
  prepareDir(dir);
  const tmp = tempPath(dir, 'nova');
  writeFileSync(tmp, `${JSON.stringify(toFile(lock), null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return tmp;
}

/** Writes the whole lock at once, over any existing one: a reader sees the old or the new, never half. */
export function writeLock(lock: Lock, dir = defaultDir()): void {
  const tmp = writeTemp(lock, dir);
  try {
    renameSync(tmp, lockFilePath(dir));
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * Creates the lock only if there is none (`link` fails if the file exists): of two trying at the
 * same time, only one succeeds. `false` if there already was a lock.
 */
export function createLock(lock: Lock, dir = defaultDir()): boolean {
  const tmp = writeTemp(lock, dir);
  try {
    linkSync(tmp, lockFilePath(dir));
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * Removes the lock only if it is the expected one (`token`, or `null` for an unreadable one). Moves
 * before reading: if meanwhile another core wrote its own, it goes back in place. `true` if removed.
 */
export function removeLock(token: string | null, dir = defaultDir()): boolean {
  const file = lockFilePath(dir);
  const moved = tempPath(dir, 'velha');
  try {
    renameSync(file, moved);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
  const t = readLockFile(moved);
  const wasExpected = token === null ? t === 'invalid' : t !== null && t !== 'invalid' && t.token === token;
  if (!wasExpected) {
    try {
      linkSync(moved, file);
    } catch (e) {
      // EEXIST: there is already a newer one than the one removed by mistake; that one stays.
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
  rmSync(moved, { force: true });
  return wasExpected;
}

/** Deletes the lock only if it still belongs to this token (another core may have recovered it). */
export function releaseLock(token: string, dir = defaultDir()): boolean {
  return removeLock(token, dir);
}
