// The core's lock: `~/.ahrena-console/nucleo.json`, with pid, port, version, start time and a token
// for local clients (decision 0005, item 4). Atomic write (temporary file and `rename`), readable
// only by the owner (0600). The core writes it, once the port is already its own.
//
// The file keeps its Portuguese keys (`porta`, `versao`, `inicio`, `pai`): other installed cores
// read it. `Lock` is the in-memory shape; `toFile` and `readLockFile` map the two.

import { randomBytes } from 'node:crypto';
import { chmodSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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

/** The lock as it is on disk. Its keys never change: other cores read the same file. */
interface LockFile {
  pid: number;
  porta: number;
  versao: string;
  inicio: string;
  token: string;
  pai: number | null;
}

const toFile = (l: Lock): LockFile => ({ pid: l.pid, porta: l.port, versao: l.version, inicio: l.startedAt, token: l.token, pai: l.parent });

export const LOCK_FILE_NAME = 'nucleo.json';

export function defaultDir(): string {
  return join(homedir(), '.ahrena-console');
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
    if (!isPositiveInt(t.pid) || !isPositiveInt(t.porta) || typeof t.versao !== 'string' || typeof t.inicio !== 'string' || typeof t.token !== 'string') {
      return 'invalid';
    }
    return { pid: t.pid!, port: t.porta!, version: t.versao, startedAt: t.inicio, token: t.token, parent: isPositiveInt(t.pai) ? t.pai! : null };
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
