// The remote machines the núcleo reads (#176, decision 0008 section 2), from the user's
// `~/.ahrena-console/machines.json`:
//
//   { "machines": [ { "id": "workstation", "label": "Workstation", "port": 14720 } ] }
//
// `port` is the LOCAL port of this Mac that the user's own tunnel forwards to the remote núcleo's
// 4720. The file names no host, no user and no key: the núcleo never opens SSH.
//
// - No file: no remote machine (only `local`); the sidebar does not show the item.
// - An invalid file (bad JSON, wrong shape, any invalid entry, a repeated id, the reserved `local`):
//   logged, and no remote machine. One bad line voids the whole file, so a typo never leaves a
//   half-configured fleet that looks right.
//
// The path is injectable (tests and `--machines`), like `contas.json` in src/api/contas.ts. The file
// is read once, when the núcleo starts.

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LOCAL_MACHINE_ID, MACHINE_ID } from './model.ts';

export interface RemoteMachineConfig {
  id: string;
  label: string;
  port: number;
}

export type MachinesFileStatus = 'missing' | 'invalid' | 'ok';

export interface MachinesConfig {
  status: MachinesFileStatus;
  machines: RemoteMachineConfig[];
}

/** Longest label kept, so a long one never breaks the sidebar or the tray. */
export const MAX_LABEL_LENGTH = 40;

export function defaultMachinesFile(): string {
  return join(homedir(), '.ahrena-console', 'machines.json');
}

/** The remote machines in the file's text, or the reason it is invalid. Pure. */
export function parseMachinesConfig(text: string): RemoteMachineConfig[] | string {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return `not JSON (${(err as Error).message})`;
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { machines?: unknown }).machines)) return 'expected { "machines": [...] }';
  const machines: RemoteMachineConfig[] = [];
  const seen = new Set<string>();
  for (const [i, entry] of ((raw as { machines: unknown[] }).machines).entries()) {
    const at = `machines[${i}]`;
    if (!entry || typeof entry !== 'object') return `${at}: expected an object`;
    const { id, label, port } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || !MACHINE_ID.test(id)) return `${at}.id: lowercase letters, digits and hyphens`;
    if (id === LOCAL_MACHINE_ID) return `${at}.id: "${LOCAL_MACHINE_ID}" is this machine`;
    if (seen.has(id)) return `${at}.id: "${id}" repeated`;
    if (typeof label !== 'string' || !label.trim()) return `${at}.label: a non-empty text`;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) return `${at}.port: an integer from 1 to 65535`;
    seen.add(id);
    machines.push({ id, label: label.trim().slice(0, MAX_LABEL_LENGTH), port });
  }
  return machines;
}

export interface LoadMachinesOptions {
  /** `null` turns the file off (the demo). */
  file?: string | null;
  log?: (message: string) => void;
  read?: (path: string) => Promise<string>;
}

export async function loadMachinesConfig({ file = defaultMachinesFile(), log, read = (p) => readFile(p, 'utf8') }: LoadMachinesOptions = {}): Promise<MachinesConfig> {
  if (!file) return { status: 'missing', machines: [] };
  let text: string;
  try {
    text = await read(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing', machines: [] };
    log?.(`machines: could not read ${file} (${(err as Error).message}); only this machine`);
    return { status: 'invalid', machines: [] };
  }
  const parsed = parseMachinesConfig(text);
  if (typeof parsed === 'string') {
    log?.(`machines: ${file} is invalid (${parsed}); only this machine`);
    return { status: 'invalid', machines: [] };
  }
  return { status: 'ok', machines: parsed };
}
