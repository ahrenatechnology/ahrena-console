// The remote machines the núcleo reads (#176, decision 0008 section 2), from the user's
// `~/.ahrena-console/machines.json`:
//
//   { "machines": [ { "id": "workstation", "label": "Workstation", "port": 14720,
//       "reconnect": { "command": ["/path/to/connect.sh", "tunnel", "restart"], "timeoutSeconds": 180 } } ] }
//
// `port` is the LOCAL port of this Mac that the user's own tunnel forwards to the remote núcleo's
// 4720. The file names no host, no user and no key: the núcleo never opens SSH.
//
// `reconnect` is optional (#244, decision 0012 section 1): the command the user wrote to bring the
// tunnel back, as a LIST (executable, then each argument; no shell, no expansion), and its timeout
// (10 to 900 s, 180 by default). An invalid `reconnect` drops only that field, with a log line: the
// machine stays, as if it had no command.
//
// - No file: no remote machine (only `local`); the sidebar does not show the item.
// - An invalid file (bad JSON, wrong shape, any invalid entry, a repeated id, the reserved `local`):
//   logged, and no remote machine. One bad line voids the whole file, so a typo never leaves a
//   half-configured fleet that looks right.
//
// The path is injectable (tests and `--machines`), like `contas.json` in src/api/accounts.ts. The file
// is read live (#244, decision 0012 section 2): `MachinesFileSource.refresh()` stats it every 30 s and
// right before a reconnect, and parses it again only when its modification time or size changed. An
// invalid file keeps the last good reading (on the first read, no remote machine, as before).

import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LOCAL_MACHINE_ID, MACHINE_ID } from './model.ts';

export interface ReconnectConfig {
  /** The executable (absolute path or a name on the PATH), then each argument. */
  command: string[];
  timeoutSeconds: number;
}

export interface RemoteMachineConfig {
  id: string;
  label: string;
  port: number;
  /** Only when the file has a valid one. */
  reconnect?: ReconnectConfig;
}

export type MachinesFileStatus = 'missing' | 'invalid' | 'ok';

export interface MachinesConfig {
  status: MachinesFileStatus;
  machines: RemoteMachineConfig[];
}

/** Longest label kept, so a long one never breaks the sidebar or the tray. */
export const MAX_LABEL_LENGTH = 40;

export const DEFAULT_RECONNECT_TIMEOUT_SECONDS = 180;
export const MIN_RECONNECT_TIMEOUT_SECONDS = 10;
export const MAX_RECONNECT_TIMEOUT_SECONDS = 900;
export const MAX_COMMAND_ITEMS = 32;
export const MAX_COMMAND_ITEM_LENGTH = 1024;

/** A machine's `reconnect`, or the reason it is invalid. Pure. */
export function parseReconnect(v: unknown): ReconnectConfig | string {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'expected { "command": [...], "timeoutSeconds": n }';
  const { command, timeoutSeconds } = v as Record<string, unknown>;
  if (!Array.isArray(command) || command.length === 0) return '.command: a non-empty list (the executable, then each argument)';
  if (command.length > MAX_COMMAND_ITEMS) return `.command: at most ${MAX_COMMAND_ITEMS} items`;
  for (const item of command) {
    if (typeof item !== 'string' || !item) return '.command: each item a non-empty text';
    if (item.length > MAX_COMMAND_ITEM_LENGTH) return `.command: each item at most ${MAX_COMMAND_ITEM_LENGTH} characters`;
    if (item.includes('\0')) return '.command: no NUL character';
  }
  const timeout = timeoutSeconds ?? DEFAULT_RECONNECT_TIMEOUT_SECONDS;
  if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < MIN_RECONNECT_TIMEOUT_SECONDS || timeout > MAX_RECONNECT_TIMEOUT_SECONDS) {
    return `.timeoutSeconds: an integer from ${MIN_RECONNECT_TIMEOUT_SECONDS} to ${MAX_RECONNECT_TIMEOUT_SECONDS}`;
  }
  return { command: [...(command as string[])], timeoutSeconds: timeout };
}

export function defaultMachinesFile(): string {
  return join(homedir(), '.ahrena-console', 'machines.json');
}

/**
 * The remote machines in the file's text, or the reason it is invalid. Pure: an invalid `reconnect`
 * (which drops only that field) is reported through `warn`.
 */
export function parseMachinesConfig(text: string, warn?: (message: string) => void): RemoteMachineConfig[] | string {
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
    const { id, label, port, reconnect } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || !MACHINE_ID.test(id)) return `${at}.id: lowercase letters, digits and hyphens`;
    if (id === LOCAL_MACHINE_ID) return `${at}.id: "${LOCAL_MACHINE_ID}" is this machine`;
    if (seen.has(id)) return `${at}.id: "${id}" repeated`;
    if (typeof label !== 'string' || !label.trim()) return `${at}.label: a non-empty text`;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) return `${at}.port: an integer from 1 to 65535`;
    seen.add(id);
    const machine: RemoteMachineConfig = { id, label: label.trim().slice(0, MAX_LABEL_LENGTH), port };
    if (reconnect !== undefined) {
      const r = parseReconnect(reconnect);
      if (typeof r === 'string') {
        const why = r.startsWith('.') ? r : `: ${r}`;
        warn?.(`${at}.reconnect${why}; ignored`);
      } else machine.reconnect = r;
    }
    machines.push(machine);
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
  const parsed = parseMachinesConfig(text, (m) => log?.(`machines: ${file}: ${m}`));
  if (typeof parsed === 'string') {
    log?.(`machines: ${file} is invalid (${parsed}); only this machine`);
    return { status: 'invalid', machines: [] };
  }
  return { status: 'ok', machines: parsed };
}

/** What decides whether the file changed since the last read. */
export interface FileStamp {
  mtimeMs: number;
  size: number;
}

export interface MachinesFileSourceOptions {
  /** `null` turns the file off (the demo). */
  file?: string | null;
  log?: (message: string) => void;
  read?: (path: string) => Promise<string>;
  stat?: (path: string) => Promise<FileStamp>;
}

export interface MachinesRefresh {
  config: MachinesConfig;
  /** The machines may differ from the previous refresh. */
  changed: boolean;
}

/**
 * machines.json read live (#244): `refresh()` stats the file and parses it again only when its stamp
 * changed. An invalid file is logged once per write and keeps the last good reading; a file that
 * disappears leaves no remote machine.
 */
export class MachinesFileSource {
  private readonly file: string | null;
  private readonly o: MachinesFileSourceOptions;
  private last: MachinesConfig = { status: 'missing', machines: [] };
  private stamp: string | null = null;
  private everRead = false;

  constructor(options: MachinesFileSourceOptions = {}) {
    this.o = options;
    this.file = options.file === undefined ? defaultMachinesFile() : options.file;
  }

  current(): MachinesConfig {
    return this.last;
  }

  async refresh(): Promise<MachinesRefresh> {
    const { file } = this;
    if (!file) return { config: this.last, changed: false };
    const statFile = this.o.stat ?? (async (p: string) => {
      const s = await stat(p);
      return { mtimeMs: s.mtimeMs, size: s.size };
    });
    let stamp: FileStamp;
    try {
      stamp = await statFile(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        const changed = this.stamp !== 'missing' && (this.last.machines.length > 0 || this.last.status !== 'missing');
        this.stamp = 'missing';
        this.everRead = true;
        if (changed) this.last = { status: 'missing', machines: [] };
        return { config: this.last, changed };
      }
      this.o.log?.(`machines: could not read ${file} (${(err as Error).message}); keeping the last good reading`);
      return { config: this.last, changed: false };
    }
    const key = `${stamp.mtimeMs}:${stamp.size}`;
    if (key === this.stamp) return { config: this.last, changed: false };
    this.stamp = key;
    let text: string;
    try {
      text = await (this.o.read ?? ((p: string) => readFile(p, 'utf8')))(file);
    } catch (err) {
      this.stamp = null; // try again on the next refresh
      this.o.log?.(`machines: could not read ${file} (${(err as Error).message}); keeping the last good reading`);
      return { config: this.last, changed: false };
    }
    const parsed = parseMachinesConfig(text, (m) => this.o.log?.(`machines: ${file}: ${m}`));
    if (typeof parsed === 'string') {
      if (!this.everRead) {
        this.everRead = true;
        this.last = { status: 'invalid', machines: [] };
        this.o.log?.(`machines: ${file} is invalid (${parsed}); only this machine`);
      } else this.o.log?.(`machines: ${file} is invalid (${parsed}); keeping the last good reading`);
      return { config: this.last, changed: false };
    }
    this.everRead = true;
    this.last = { status: 'ok', machines: parsed };
    return { config: this.last, changed: true };
  }
}
