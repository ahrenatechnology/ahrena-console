// Registered clients: whoever adopted the core with `--parent <pid>` and wants it to stay up.
// One file per pid in `~/.ahrena-console/clientes/`, so two clients never fight over the same
// file. A dead client is deleted by whoever reads. The folder and file contents keep their names:
// other installed cores read them.

import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isPidAlive } from './probe.ts';
import { defaultDir, prepareDir } from './lock.ts';

const clientsDir = (dir: string) => join(dir, 'clientes');

export function registerClient(pid: number, dir = defaultDir()): void {
  prepareDir(dir);
  const clients = clientsDir(dir);
  mkdirSync(clients, { recursive: true, mode: 0o700 });
  writeFileSync(join(clients, String(pid)), `${JSON.stringify({ pid, desde: new Date().toISOString() })}\n`, { mode: 0o600 });
}

export function removeClient(pid: number, dir = defaultDir()): void {
  rmSync(join(clientsDir(dir), String(pid)), { force: true });
}

/** The registered pids still alive; the dead ones leave the folder. */
export function liveClients(dir = defaultDir()): number[] {
  let names: string[];
  try {
    names = readdirSync(clientsDir(dir));
  } catch {
    return [];
  }
  const alive: number[] = [];
  for (const name of names) {
    const pid = Number(name);
    if (Number.isInteger(pid) && pid > 0 && isPidAlive(pid)) alive.push(pid);
    else rmSync(join(clientsDir(dir), name), { force: true });
  }
  return alive;
}
