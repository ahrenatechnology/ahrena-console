// The instance registry (decision 0010, item 3; issue #221): every core with a lock writes
// `~/.ahrena-console/instances/<id>.json` once its API listens, and deletes it on exit. Whoever needs
// a core (the hooks, the mod, the MCP, the app) reads the folder instead of assuming a port.
//
//   - One file per core, so two cores never write the same file. `id` is `<installation>-<pid>`.
//   - Atomic: a temporary file in the same folder, then `rename`. A reader sees all or nothing.
//   - The folder is 0700 and the file 0600. The lock's token never goes here: the registry only
//     says where a core is, not how to prove one read the lock.
//   - A core killed with SIGKILL leaves its file behind: whoever reads drops (and deletes) entries
//     whose pid is gone, and entries it cannot read.
//   - A live pid can still be a reused number: before sending anything that changes state,
//     `verifyInstance` checks that the port answers `/api/overview` with that pid.

import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { consoleHome, isInstallation, type Installation } from './installation.ts';
import { isPidAlive, probeCore } from './probe.ts';

export interface Instance {
  /** `<installation>-<pid>`, also the file name (without `.json`). */
  id: string;
  installation: Installation;
  pid: number;
  port: number;
  version: string;
  commit: string | null;
  /** The core's data folder (database, log, clients, lock). */
  dataDir: string;
  /** ISO 8601. */
  startedAt: string;
}

export const INSTANCES_DIR_NAME = 'instances';

const ID = /^(app|dev|mcpb)-[1-9]\d*$/;

export function instancesDir(home = consoleHome()): string {
  return join(home, INSTANCES_DIR_NAME);
}

export function instanceId(installation: Installation, pid = process.pid): string {
  return `${installation}-${pid}`;
}

function instanceFile(id: string, home: string): string {
  if (!ID.test(id)) throw new Error(`not an instance id: ${id}`);
  return join(instancesDir(home), `${id}.json`);
}

function prepareInstancesDir(home: string): string {
  const dir = instancesDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  chmodSync(dir, 0o700);
  return dir;
}

const isPositiveInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;

/** The entry, or `null` if the value is not one. Only the known keys come out, never anything else. */
function toInstance(v: unknown): Instance | null {
  if (typeof v !== 'object' || v === null) return null;
  const e = v as Record<string, unknown>;
  if (typeof e.id !== 'string' || !ID.test(e.id) || !isInstallation(e.installation) || !isPositiveInt(e.pid) || !isPositiveInt(e.port)) return null;
  if (e.id !== instanceId(e.installation, e.pid)) return null;
  if (typeof e.version !== 'string' || typeof e.dataDir !== 'string' || typeof e.startedAt !== 'string') return null;
  if (e.commit !== null && typeof e.commit !== 'string') return null;
  return { id: e.id, installation: e.installation, pid: e.pid, port: e.port, version: e.version, commit: e.commit, dataDir: e.dataDir, startedAt: e.startedAt };
}

/**
 * Writes this core's entry at once (temporary file and `rename`), with 0600 in a 0700 folder.
 * Returns the file's path. Only the fields of `Instance` are written.
 */
export function writeInstance(entry: Instance, o: { home?: string } = {}): string {
  const clean = toInstance(entry);
  if (!clean) throw new Error(`not a valid instance entry: ${JSON.stringify(entry.id)}`);
  const home = o.home ?? consoleHome();
  const dir = prepareInstancesDir(home);
  const file = instanceFile(clean.id, home);
  const tmp = join(dir, `.${clean.id}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(clean, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  try {
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return file;
}

function readEntry(file: string): Instance | 'invalid' | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    // Gone meanwhile, or not readable right now (EACCES, EMFILE, a folder): skipped, never deleted.
    return null;
  }
  try {
    return toInstance(JSON.parse(text)) ?? 'invalid';
  } catch {
    return 'invalid';
  }
}

/**
 * Deletes an entry. With `pid`, only if the entry on disk still says that pid (a core deletes only
 * its own). `true` if a file was deleted.
 */
export function removeInstance(id: string, o: { home?: string; pid?: number } = {}): boolean {
  const file = instanceFile(id, o.home ?? consoleHome());
  if (o.pid !== undefined) {
    const e = readEntry(file);
    if (e === null || e === 'invalid' || e.pid !== o.pid) return false;
  }
  try {
    rmSync(file);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}

/**
 * The live entries, oldest first (`startedAt`, then `id`). An entry whose pid is gone, or that cannot
 * be read, is dropped and its file deleted (unless `clean: false`). Temporary files are skipped.
 */
export function listInstances(o: { home?: string; clean?: boolean } = {}): Instance[] {
  const home = o.home ?? consoleHome();
  const dir = instancesDir(home);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const live: Instance[] = [];
  for (const name of names) {
    if (name.startsWith('.') || !name.endsWith('.json')) continue;
    const file = join(dir, name);
    const e = readEntry(file);
    if (e === null) continue;
    const ok = e !== 'invalid' && name === `${e.id}.json` && isPidAlive(e.pid);
    if (ok) live.push(e);
    else if (o.clean !== false) {
      try {
        rmSync(file, { force: true });
      } catch {
        /* not a file: left alone */
      }
    }
  }
  return live.sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : a.id.localeCompare(b.id)));
}

/**
 * The core to talk to: the oldest live entry of `installation`, else the oldest live entry of any
 * installation, else `null` (decision 0010, item 5).
 */
export function pickInstance(o: { installation: Installation; home?: string }): Instance | null {
  const live = listInstances({ home: o.home });
  return live.find((i) => i.installation === o.installation) ?? live[0] ?? null;
}

/**
 * `true` if the entry's port answers `/api/overview` as a core with the entry's pid: the pid was not
 * reused and the port is still its own. Check it before sending anything that changes state.
 */
export async function verifyInstance(i: Instance, timeoutMs = 1000): Promise<boolean> {
  if (!isPidAlive(i.pid)) return false;
  const v = await probeCore(i.port, timeoutMs);
  return v !== null && v.pid === i.pid;
}
