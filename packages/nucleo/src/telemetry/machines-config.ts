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
// `connection` is optional too (#278, decision 0013 section 4): it generalizes `reconnect` with a stop
// command and a link to a cloud profile of this Mac:
//
//   "connection": { "start": { "command": [...], "timeoutSeconds": 180 },
//                   "stop": { "command": [...] },
//                   "cloudProfile": { "connector": "aws", "profile": "perfil-dev" } }
//
// `connection.credential` (#388, decision 0020 section 1) is the command that brings the remote owner's
// credential over the SSH that already entered there: `{ "command": [...], "timeoutSeconds": 20 }` (5 to
// 60 s), a list, no shell, like `start`. Its request goes on stdin and its answer comes on stdout, which
// stays in memory (telemetry/remote-proof.ts); an invalid `credential` drops only that field.
//
// `connection.checkout` (issue 449, decision 0021 section 2) is the absolute path of the núcleo's checkout on
// the remote machine. It is never run: it only fills the update command the screen shows. An invalid one
// drops only that field (`parseCheckout`).
//
// `connection.update` (issue 462, decision 0022 section 1) is the command the Update button runs: `{ "command": [...],
// "timeoutSeconds": 300 }` (60 to 900 s), a list, no shell, like `credential`. It is the SSH to the remote machine plus
// `node --input-type=module -` and the script's own flags (`--checkout`, `--port`); the núcleo appends a closed tail
// after it (telemetry/core-update-protocol.ts) and sends the script on stdin. A command that already carries a flag of
// the tail, or one that would loosen the update (`--allow-disconnect`, `--force`, `--core-options`) or run another
// command (`install-unit`), is invalid: only that field is dropped, with a log line, and `updateProblem` keeps a fixed
// reason the screen can show (never the value).
//
// `start` and `stop` follow the rules and limits of `reconnect`. An invalid `stop` or `cloudProfile`
// drops only that field, and an invalid `start` drops the whole `connection`, each with a log line:
// the machine stays. A lone `reconnect` is read as `connection.start` (`connectionOf`); with both,
// `connection` wins, the log says so, and `reconnect` becomes `connection.start` (so the old
// Reconnect route keeps running the start command).
//
// - No file: no remote machine (only `local`); the sidebar does not show the item.
// - An invalid file (bad JSON, wrong shape, any invalid entry, a repeated id, the reserved `local`):
//   logged, and no remote machine. One bad line voids the whole file, so a typo never leaves a
//   half-configured fleet that looks right.
//
// The path is injectable (tests and `--machines`), like `contas.json` in src/api/accounts.ts. The file
// is read live (#244, decision 0012 section 2): `MachinesFileSource.refresh()` stats it every 30 s and
// right before a reconnect, and parses it again only when its modification time or size changed. An
// invalid file keeps the last good reading for display (on the first read, no remote machine, as
// before), and says so (`invalid`): a reconnect is refused until the file is fixed.

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { consoleHome } from '../owner/installation.ts';
import { LOCAL_MACHINE_ID, MACHINE_ID } from './model.ts';

export interface ReconnectConfig {
  /** The executable (absolute path or a name on the PATH), then each argument. */
  command: string[];
  timeoutSeconds: number;
}

/** The cloud profile of THIS Mac the tunnel depends on (#278); the name must match `SAFE_PROFILE_NAME`. */
export interface CloudProfileLink {
  connector: 'aws';
  profile: string;
}

/** A remote machine's connection (#278, decision 0013 section 4). */
export interface ConnectionConfig {
  start: ReconnectConfig;
  stop?: ReconnectConfig;
  cloudProfile?: CloudProfileLink;
  /** The remote owner's credential command (#388, decision 0020 section 1). */
  credential?: ReconnectConfig;
  /** The núcleo's checkout on the remote machine (issue 449, decision 0021 section 2): text for the update command, never executed. */
  checkout?: string;
  /** The Update button's command (issue 462, decision 0022 section 1). */
  update?: ReconnectConfig;
  /** Why `update` was in the file but invalid: a fixed word, never the value. Absent when `update` is valid or not there. */
  updateProblem?: UpdateProblem;
}

export interface RemoteMachineConfig {
  id: string;
  label: string;
  port: number;
  /** Only when the file has a valid one; with a `connection`, its `start`. */
  reconnect?: ReconnectConfig;
  /** Only when the file has a valid one (a lone `reconnect` is not copied here: see `connectionOf`). */
  connection?: ConnectionConfig;
}

/** The same rule as the AWS connector's `SAFE_CLI_NAME` (src/clouds/aws-config.ts): the name may go on a command line. */
export const SAFE_PROFILE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
export const CLOUD_CONNECTORS = ['aws'] as const;

/** The machine's connection: its `connection`, or a lone `reconnect` read as `connection.start`; `null` without either. */
export function connectionOf(machine: Pick<RemoteMachineConfig, 'reconnect' | 'connection'>): ConnectionConfig | null {
  if (machine.connection) return machine.connection;
  return machine.reconnect ? { start: machine.reconnect } : null;
}

/**
 * A machine's `connection`, or the reason it is invalid as a whole (a missing or invalid `start`).
 * An invalid `stop` or `cloudProfile` drops only that field, reported through `warn` (`.stop: why`).
 */
export function parseConnection(v: unknown, warn?: (message: string) => void): ConnectionConfig | string {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'expected { "start": { "command": [...] }, "stop"?: {...}, "cloudProfile"?: {...} }';
  const { start, stop, cloudProfile, credential, checkout, update } = v as Record<string, unknown>;
  if (start === undefined) return '.start: required';
  const s = parseReconnect(start);
  if (typeof s === 'string') return `.start${s.startsWith('.') ? s : `: ${s}`}`;
  const out: ConnectionConfig = { start: s };
  if (stop !== undefined) {
    const t = parseReconnect(stop);
    if (typeof t === 'string') warn?.(`.stop${t.startsWith('.') ? t : `: ${t}`}; ignored`);
    else out.stop = t;
  }
  if (cloudProfile !== undefined) {
    const c = parseCloudProfile(cloudProfile);
    if (typeof c === 'string') warn?.(`.cloudProfile${c}; ignored`);
    else out.cloudProfile = c;
  }
  if (credential !== undefined) {
    const c = parseCredential(credential);
    if (typeof c === 'string') warn?.(`.credential${c.startsWith('.') ? c : `: ${c}`}; ignored`);
    else out.credential = c;
  }
  if (checkout !== undefined) {
    const c = parseCheckout(checkout);
    if (typeof c === 'string') out.checkout = c;
    else warn?.(`.checkout: ${c.refused}; ignored`);
  }
  if (update !== undefined) {
    const u = parseUpdate(update);
    if ('problem' in u) {
      out.updateProblem = u.problem;
      warn?.(`.update: ${u.problem}; ignored`);
    } else out.update = u;
  }
  return out;
}

export const DEFAULT_UPDATE_TIMEOUT_SECONDS = 300;
export const MIN_UPDATE_TIMEOUT_SECONDS = 60;
export const MAX_UPDATE_TIMEOUT_SECONDS = 900;

/** Why a `connection.update` is invalid: a CLOSED list, so the screen can say it without echoing the file. */
export const UPDATE_PROBLEMS = ['not-an-object', 'bad-command', 'bad-timeout', 'forbidden-flag'] as const;
export type UpdateProblem = (typeof UPDATE_PROBLEMS)[number];

/**
 * The flags and words a declared update command may not carry: the ones that loosen the update, the one that runs
 * another command, and the ones of the closed tail the núcleo appends itself (decision 0022 sections 1 and 3).
 */
export const FORBIDDEN_UPDATE_ITEMS = ['--allow-disconnect', '--force', '--core-options', 'install-unit', '--ref', '--check', '--progress', '--mac-telemetry-version', '--mac-credential-command'] as const;

/** Whether an item of the command is (or is `--flag=value` of) a forbidden one. */
export function isForbiddenUpdateItem(item: string): boolean {
  // ssh joins the argv and the remote shell reads it again: an item with spaces is several words there.
  return item.split(/\s+/).some((w) => FORBIDDEN_UPDATE_ITEMS.some((f) => w === f || w.startsWith(`${f}=`)));
}

/** A machine's `connection.update`, or its fixed problem: the command rules of `reconnect`, 60 to 900 s (300 by default), no forbidden item. Pure. */
export function parseUpdate(v: unknown): ReconnectConfig | { problem: UpdateProblem } {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { problem: 'not-an-object' };
  const declared = (v as Record<string, unknown>).timeoutSeconds;
  const timeout = declared === undefined ? DEFAULT_UPDATE_TIMEOUT_SECONDS : declared;
  const command = parseReconnect({ command: (v as Record<string, unknown>).command });
  if (typeof command === 'string') return { problem: 'bad-command' };
  if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < MIN_UPDATE_TIMEOUT_SECONDS || timeout > MAX_UPDATE_TIMEOUT_SECONDS) return { problem: 'bad-timeout' };
  if (command.command.some(isForbiddenUpdateItem)) return { problem: 'forbidden-flag' };
  return { command: command.command, timeoutSeconds: timeout };
}

export const MAX_CHECKOUT_LENGTH = 512;

/**
 * A machine's `connection.checkout`, or why it is refused (never the value, which may be a secret that landed
 * in the wrong field). Absolute, at most 512 characters, no `..` segment, no `~`, NUL, control character,
 * backslash, `$` or backtick. It is the owner's own file, and the path ends up in a command the person pastes
 * (issue 449): consumers must single-quote it. Pure.
 */
export function parseCheckout(v: unknown): string | { refused: string } {
  if (typeof v !== 'string' || !v) return { refused: 'a non-empty text' };
  if (v.length > MAX_CHECKOUT_LENGTH) return { refused: `at most ${MAX_CHECKOUT_LENGTH} characters` };
  if (!v.startsWith('/')) return { refused: 'an absolute path (starts with /)' };
  if (v.split('/').includes('..')) return { refused: 'no ".." segment' };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f~$`\\]/.test(v)) return { refused: 'no ~, $, backtick, backslash or control character' };
  return v;
}

export const DEFAULT_CREDENTIAL_TIMEOUT_SECONDS = 20;
export const MIN_CREDENTIAL_TIMEOUT_SECONDS = 5;
export const MAX_CREDENTIAL_TIMEOUT_SECONDS = 60;

/** A machine's `connection.credential`, or the reason it is invalid: the command rules of `reconnect`, 5 to 60 s (20 by default). Pure. */
export function parseCredential(v: unknown): ReconnectConfig | string {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'expected { "command": [...], "timeoutSeconds": n }';
  const timeout = (v as Record<string, unknown>).timeoutSeconds ?? DEFAULT_CREDENTIAL_TIMEOUT_SECONDS;
  if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < MIN_CREDENTIAL_TIMEOUT_SECONDS || timeout > MAX_CREDENTIAL_TIMEOUT_SECONDS) {
    return `.timeoutSeconds: an integer from ${MIN_CREDENTIAL_TIMEOUT_SECONDS} to ${MAX_CREDENTIAL_TIMEOUT_SECONDS}`;
  }
  const parsed = parseReconnect({ command: (v as Record<string, unknown>).command });
  return typeof parsed === 'string' ? parsed : { command: parsed.command, timeoutSeconds: timeout };
}

function parseCloudProfile(v: unknown): CloudProfileLink | string {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return ': expected { "connector": "aws", "profile": "<name>" }';
  const { connector, profile } = v as Record<string, unknown>;
  if (typeof connector !== 'string' || !(CLOUD_CONNECTORS as readonly string[]).includes(connector)) return `.connector: one of ${CLOUD_CONNECTORS.join(', ')}`;
  if (typeof profile !== 'string' || !SAFE_PROFILE_NAME.test(profile)) return '.profile: letters, digits, dot, hyphen and underscore, up to 64';
  return { connector: connector as CloudProfileLink['connector'], profile };
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

/** In the console home (`AHRENA_CONSOLE_HOME`, or `~/.ahrena-console`), like the instance registry. */
export function defaultMachinesFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(consoleHome(env), 'machines.json');
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
    const { id, label, port, reconnect, connection } = entry as Record<string, unknown>;
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
    if (connection !== undefined) {
      const c = parseConnection(connection, (m) => warn?.(`${at}.connection${m}`));
      if (typeof c === 'string') {
        const why = c.startsWith('.') ? c : `: ${c}`;
        warn?.(`${at}.connection${why}; ignored${machine.reconnect ? ' (the "reconnect" applies)' : ''}`);
      } else {
        if (reconnect !== undefined) warn?.(`${at}: both "reconnect" and "connection"; "connection" wins and "reconnect" is ignored`);
        machine.connection = c;
        machine.reconnect = c.start;
      }
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
  /**
   * The file as it is now does not parse (the machines are the last good reading's). A reconnect is
   * refused until it is fixed (#244): the command shown may be one the user is trying to remove.
   */
  invalid: boolean;
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
  private invalidNow = false;

  constructor(options: MachinesFileSourceOptions = {}) {
    this.o = options;
    this.file = options.file === undefined ? defaultMachinesFile() : options.file;
  }

  current(): MachinesConfig {
    return this.last;
  }

  async refresh(): Promise<MachinesRefresh> {
    const { file } = this;
    if (!file) return { config: this.last, changed: false, invalid: false };
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
        this.invalidNow = false;
        return { config: this.last, changed, invalid: false };
      }
      this.o.log?.(`machines: could not read ${file} (${(err as Error).message}); keeping the last good reading`);
      return { config: this.last, changed: false, invalid: this.invalidNow };
    }
    const key = `${stamp.mtimeMs}:${stamp.size}`;
    if (key === this.stamp) return { config: this.last, changed: false, invalid: this.invalidNow };
    this.stamp = key;
    let text: string;
    try {
      text = await (this.o.read ?? ((p: string) => readFile(p, 'utf8')))(file);
    } catch (err) {
      this.stamp = null; // try again on the next refresh
      this.o.log?.(`machines: could not read ${file} (${(err as Error).message}); keeping the last good reading`);
      return { config: this.last, changed: false, invalid: this.invalidNow };
    }
    const parsed = parseMachinesConfig(text, (m) => this.o.log?.(`machines: ${file}: ${m}`));
    if (typeof parsed === 'string') {
      if (!this.everRead) {
        this.everRead = true;
        this.last = { status: 'invalid', machines: [] };
        this.o.log?.(`machines: ${file} is invalid (${parsed}); only this machine`);
      } else this.o.log?.(`machines: ${file} is invalid (${parsed}); keeping the last good reading`);
      this.invalidNow = true;
      return { config: this.last, changed: false, invalid: true };
    }
    this.everRead = true;
    this.invalidNow = false;
    this.last = { status: 'ok', machines: parsed };
    return { config: this.last, changed: true, invalid: false };
  }
}
