// Clients of a core of another installation (decision 0027, issue #706). A bridge that uses a core
// outside its own data folder (rule 3 of src/mcp/target.ts: a checkout's bridge on the app's core)
// must keep that core up too, but it never writes into a data folder it only read in the registry.
// So it registers here instead, in the per-user folder it already shares with every core
// (`~/.ahrena-console`, next to the instance registry): one file per pid under
// `instance-clients/<instance id>/`. The core counts these together with its own `clientes/`.

import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { consoleHome } from './installation.ts';
import { isPidAlive } from './probe.ts';
import { isInstanceId } from './registry.ts';

export const INSTANCE_CLIENTS_DIR_NAME = 'instance-clients';

function clientsDir(id: string, home: string): string {
  if (!isInstanceId(id)) throw new Error(`not an instance id: ${id}`);
  return join(home, INSTANCE_CLIENTS_DIR_NAME, id);
}

/** Registers `pid` as a client of the core whose registry id is `id`. */
export function registerInstanceClient(pid: number, id: string, o: { home?: string } = {}): void {
  const dir = clientsDir(id, o.home ?? consoleHome());
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, String(pid)), `${JSON.stringify({ pid, since: new Date().toISOString() })}\n`, { mode: 0o600 });
}

/** The registered pids of core `id` still alive; the dead ones leave the folder. */
export function liveInstanceClients(id: string, o: { home?: string } = {}): number[] {
  const dir = clientsDir(id, o.home ?? consoleHome());
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const alive: number[] = [];
  for (const name of names) {
    const pid = Number(name);
    if (Number.isInteger(pid) && pid > 0 && isPidAlive(pid)) alive.push(pid);
    else rmSync(join(dir, name), { force: true });
  }
  return alive;
}

/** The core `id` is exiting: its clients folder goes with it. */
export function removeInstanceClients(id: string, o: { home?: string } = {}): void {
  rmSync(clientsDir(id, o.home ?? consoleHome()), { recursive: true, force: true });
}
