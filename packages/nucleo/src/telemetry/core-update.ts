// The remote core's update job, Mac side (issue 462, decision 0022; issue 484, decision 0024). What this module
// guarantees:
//
// - The command comes from the FRESHEST reading of machines.json (`lookup`, which refreshes it); while the file is
//   invalid nothing runs. It is the declared `connection.update.command` when valid (`source: 'declared'`); with
//   none declared, the one `buildUpdateBlock` derives from `connection.credential`: the user's own SSH prefix as
//   written, the remote program swapped for `node --input-type=module -` on the same checkout (`source:
//   'derived'`, decision 0024 section 1). An INVALID declared update runs nothing and never falls back to the
//   derived one (core-update-block.ts `resolveUpdateCommand`). The núcleo appends the closed tail of
//   core-update-protocol.ts (`--ref`, `--mac-telemetry-version`, `--mac-credential-command`, `--progress json`,
//   and `--check` for the check step) and nothing else: no text of the request reaches the argv (the routes pass
//   the machine id only), and `--allow-disconnect`, `--force` and `--core-options` never appear (the validator
//   refuses them in the declared and the derived command alike, machines-config.ts `parseUpdate`).
// - The automatic run (decision 0024 section 2): `considerAuto`, called after each good read of the remote's
//   overview, starts the `--check` by itself when the remote answers a version strictly older than the app's, the
//   app's version has a tag, the machine has a credential and a command, and nothing of the machine runs; a check
//   that ends `ready` chains the update at once (it pays for it like the route's, with no confirm window). Once per
//   (machine, target): the attempt is spent the instant it starts, in `AutoAttempts` (`core-update-auto.json` in
//   production, `fileAutoAttempts`), and a refused or failed attempt is never repeated by itself; the routes
//   ("Tentar de novo") still work. A manual update, and any run that exits 21 or 22, spend it too.
// - `spawn(command[0], rest, { shell: false, detached: true })`: no shell, its own process group, stdout to a pipe
//   read in memory (64 KiB), stderr discarded, and the app's own update script written to stdin, which the remote
//   `node --input-type=module -` runs (decision 0022 section 2). The script is the file packaged with the app.
// - One job per machine, from anywhere: a second click gets the one that runs (also while a canceled process dies).
// - The UPDATE needs a good `--check` of the same machine, command and target within 5 minutes
//   (`check-required` otherwise); one check pays for one update.
// - The decision is the ssh exit code (the script's, passed through); the NDJSON events only give the phase, the
//   reason and the backup path. A phase never moves back.
// - Cancel only while the phase is `check`: the script ignores signals from `backup` on, so nothing promises
//   more (section 6). A timeout in the check phase (or before any phase) ends the process group; a timeout from
//   `backup` on does NOT touch ssh: the script runs to the end alone, the state says `timed-out` meanwhile, and the
//   real exit code still decides when it arrives. (Decision 0022 section 6 says "before the swap"; the script's
//   signals handling starts at `backup`, so that is the line where killing ssh stops meaning anything.)
// - On exit 0 of the update the machine's credential is dropped and the machine is read at once (`onUpdated`); the
//   state stays `succeeded` and reads `confirming` until the remote's own version equals the target, `diverged` if
//   2 minutes pass without it.
// - The log gets one line per start (`update (<id>): <kind> started`, plus `automatic` for the Mac's own run) and
//   one per end, `update (<id>): <kind> <state> exit <n>`; never the output nor the script.

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildUpdateBlock, resolveUpdateCommand, type UpdateSource } from './core-update-block.ts';
import {
  buildTail,
  classify,
  pastCheck,
  phaseAdvances,
  ProgressParser,
  reasonFits,
  refOf,
  type UpdatePhase,
  type UpdateState,
} from './core-update-protocol.ts';
import { compareSemver } from './core-version.ts';
import { renderUpdateText, textKeyOrFallback, type UpdateTextKey, type UpdateTextParams } from './core-update-texts.ts';
import { DEFAULT_UPDATE_TIMEOUT_SECONDS, type ConnectionConfig, type ReconnectConfig, type UpdateProblem } from './machines-config.ts';
import { reconnectEnv, signalGroup } from './reconnect.ts';

/** The packaged script (`scripts/remote-core/update-remote-core.mjs`), at the same relative place in the checkout and in the app's resources. */
export const UPDATE_SCRIPT_URL = new URL('../../../../scripts/remote-core/update-remote-core.mjs', import.meta.url);
/** The script is refused above this size (decision 0022 section 2). */
export const MAX_UPDATE_SCRIPT_BYTES = 256 * 1024;
export const CHECK_TIMEOUT_SECONDS = 30;
/** A good check lets an update start for this long. */
export const CHECK_VALID_MS = 5 * 60_000;
/** After an exit 0, the remote's own version has this long to show the target before the screen says it diverged. */
export const CONFIRM_WINDOW_MS = 2 * 60_000;
export const UPDATE_KILL_GRACE_MS = 5_000;
/** A hung ssh past the timeout of an update is ended after this many more timeouts (the script ignores signals and runs on alone). */
const HARD_CAP_FACTOR = 2;

export type UpdateRefusal = 'invalid-file' | 'not-configured' | 'invalid' | 'invalid-version' | 'check-required' | 'not-cancelable' | 'not-running';

export type UpdateProblemKind = 'missing' | 'invalid' | 'credential-missing' | 'invalid-file';

/** The automatic attempt for the app's version (decision 0024 section 3). */
export interface AutoAttempt {
  target: string;
  state: 'running' | 'succeeded' | 'failed';
}

/** Which target each machine's automatic attempt was spent on: only the last one per machine (decision 0024 section 2). */
export interface AutoAttempts {
  spent(machineId: string): string | null;
  spend(machineId: string, target: string): void;
}

/** The file of spent attempts, in the data folder. */
export const AUTO_ATTEMPTS_FILE = 'core-update-auto.json';

export function autoAttemptsFile(dataDir: string): string {
  return join(dataDir, AUTO_ATTEMPTS_FILE);
}

const TARGET = /^\d+\.\d+\.\d+$/;

/** In memory only: the default, and what tests use when the file is not the point. */
export function memoryAutoAttempts(): AutoAttempts {
  const spent = new Map<string, string>();
  return { spent: (id) => spent.get(id) ?? null, spend: (id, target) => void spent.set(id, target) };
}

/**
 * The spent attempts in a JSON file, `{ "<machineId>": "<target>" }`, read once, lazily. An absent file is empty; an
 * unreadable or malformed one is empty with one log line (the worst case is one more attempt per target). Entries
 * that are not a version are dropped. The ids come from machines.json, so the map has no prototype (`__proto__` is
 * a plain key). Written atomically (temp file and rename, mode 0600); a failed write logs one line and keeps the
 * value in memory.
 */
export function fileAutoAttempts(file: string, log?: (message: string) => void): AutoAttempts {
  let map: Record<string, string> | null = null;
  const load = (): Record<string, string> => {
    if (map) return map;
    const m: Record<string, string> = Object.create(null);
    map = m;
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log?.(`update: ${AUTO_ATTEMPTS_FILE} unreadable, counted as empty`);
      return m;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      raw = null;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      log?.(`update: ${AUTO_ATTEMPTS_FILE} malformed, counted as empty`);
      return m;
    }
    for (const [id, target] of Object.entries(raw)) if (typeof target === 'string' && TARGET.test(target)) m[id] = target;
    return m;
  };
  return {
    spent: (id) => {
      const m = load();
      return Object.hasOwn(m, id) ? m[id]! : null;
    },
    spend: (id, target) => {
      const m = load();
      m[id] = target;
      const temp = `${file}.${process.pid}.tmp`;
      try {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(temp, `${JSON.stringify(m)}\n`, { mode: 0o600 });
        chmodSync(temp, 0o600);
        renameSync(temp, file);
      } catch {
        log?.(`update: could not write ${AUTO_ATTEMPTS_FILE}; the attempt is kept in memory`);
      }
    },
  };
}

export interface MachineUpdate {
  /** There is a valid command, declared or derived, and machines.json parses. */
  configured: boolean;
  /** Where the command came from; `null` when there is none (decision 0024 section 3). */
  source: UpdateSource | null;
  /** The run `state` talks about was started by the Mac, not by a click; `false` when there is none. */
  automatic: boolean;
  /** The automatic attempt for the app's version; `null` while there was none for this target. */
  auto: AutoAttempt | null;
  problem: UpdateProblemKind | null;
  /** Why the `connection.update` is invalid (a fixed word), when `problem` is `invalid`. */
  invalidReason: UpdateProblem | null;
  state: UpdateState;
  /** Which run `state` is about: the `--check` or the update. `null` before any. */
  kind: 'check' | 'update' | null;
  phase: UpdatePhase | null;
  /** The app's own version: what the update installs. */
  targetVersion: string;
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
  reason: string | null;
  backupPath: string | null;
  oldCommit: string | null;
  newCommit: string | null;
  canCancel: boolean;
  timeoutSeconds: number;
  /** What runs (the user's own list, without the closed tail), for the screen to show before the click. */
  command: string[];
  /** After an update that exited 0: `confirming` until the remote answers the target, `confirmed`, or `diverged` after 2 min. */
  confirmation: 'confirming' | 'confirmed' | 'diverged' | null;
  /** The version the remote's overview answers now. */
  observedVersion: string | null;
  /** While `ready`: when the check stops being good (ISO). */
  readyUntil: string | null;
  /** The pt-BR text of the state, rendered (`core-update-texts.ts`); `null` while there is nothing to say. */
  message: { key: string; text: string } | null;
  /** When `problem` is `invalid` and the credential allows it: the block to compare with what was written (the núcleo never writes the file). */
  setup: { block: string | null };
}

export type UpdateResult =
  | { kind: 'unknown' }
  | { kind: 'refused'; reason: UpdateRefusal }
  | { kind: 'started' | 'already-running' | 'canceled'; update: MachineUpdate };

/** The freshest reading of a machine, for a run. */
export type UpdateLookup = { kind: 'unknown' } | { kind: 'invalid-file' } | { kind: 'ok'; connection: ConnectionConfig | null };

/** The last good reading, for the status (synchronous). */
export interface UpdateContext {
  /** `undefined` for an unknown id. */
  connection: ConnectionConfig | null | undefined;
  fileInvalid: boolean;
}

type Spawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface CoreUpdaterOptions {
  lookup: (machineId: string) => Promise<UpdateLookup>;
  context: (machineId: string) => UpdateContext;
  /** This app's version (`API_VERSION`): the target of the update. */
  appVersion: string;
  /** What this Mac declares to the script (`TELEMETRY_VERSION`). */
  telemetryVersion: number;
  /** The remote núcleo's version as its last overview read says; `null` before one. */
  observedVersion?: (machineId: string) => string | null;
  /** After an update that exited 0: drop the machine's credential and read it at once (decision 0022 section 5). */
  onUpdated?: (machineId: string) => void | Promise<void>;
  onChange?: (machineId: string) => void;
  /** The script's text; default the packaged file. */
  script?: () => Promise<string>;
  spawn?: Spawn;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  now?: () => number;
  /** Tests shorten the time unit; 1000 in production. */
  msPerSecond?: number;
  killGraceMs?: number;
  log?: (message: string) => void;
  /** Where the spent automatic attempts are kept; default in memory (production: `fileAutoAttempts`). */
  autoAttempts?: AutoAttempts;
}

interface Job {
  kind: 'check' | 'update';
  /** Started by the Mac (`considerAuto` or the update it chains), not by a click. */
  automatic: boolean;
  state: UpdateState;
  key: string | null;
  phase: UpdatePhase | null;
  startedAt: string;
  startedMs: number;
  endedAt: string | null;
  endedMs: number | null;
  exitCode: number | null;
  reason: string | null;
  backup: string | null;
  oldCommit: string | null;
  newCommit: string | null;
  result: { exit: number; reason: string | null; backup: string | null; oldCommit: string | null; newCommit: string | null } | null;
  child: ChildProcess | null;
  alive: boolean;
  /** Our own doing: the process group was told to end. */
  stopped: boolean;
  timeoutSeconds: number;
  commandKey: string;
  command: string[];
  timer: ReturnType<typeof setTimeout> | null;
  exited: Promise<void>;
}

interface Entry {
  job: Job | null;
  /** A good check, kept until an update uses it or it expires. */
  check: { okMs: number; commandKey: string } | null;
  /** The automatic attempt of this process, for the target it ran (the spent store survives a restart, this does not). */
  auto: AutoAttempt | null;
}

const PORT_ARG = /^\d{1,5}$/;

export async function readPackagedScript(): Promise<string> {
  const text = await readFile(UPDATE_SCRIPT_URL, 'utf8');
  if (Buffer.byteLength(text) > MAX_UPDATE_SCRIPT_BYTES) throw new Error('script too large');
  return text;
}

export class CoreUpdater {
  private readonly o: CoreUpdaterOptions;
  private readonly entries = new Map<string, Entry>();
  private readonly starting = new Map<string, Promise<UpdateResult | null>>();
  private readonly attempts: AutoAttempts;

  constructor(options: CoreUpdaterOptions) {
    this.o = options;
    this.attempts = options.autoAttempts ?? memoryAutoAttempts();
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  private entry(id: string): Entry {
    let e = this.entries.get(id);
    if (!e) this.entries.set(id, (e = { job: null, check: null, auto: null }));
    return e;
  }

  /** An update (not a check) is running or still dying: the machine is "atualizando" (decision 0022 section 4). */
  updating(machineId: string): boolean {
    const j = this.entries.get(machineId)?.job;
    return j?.alive === true && j.kind === 'update';
  }

  /** Resolves when the machine's process (if any) has exited. */
  async settled(machineId: string): Promise<void> {
    await this.starting.get(machineId)?.catch(() => null);
    await this.entries.get(machineId)?.job?.exited;
  }

  /** `GET /api/machines`' `update` of a machine; `null` for an unknown id. */
  status(machineId: string): MachineUpdate | null {
    const ctx = this.o.context(machineId);
    if (ctx.connection === undefined) return null;
    const e = this.entries.get(machineId);
    const job = e?.job ?? null;
    const conn = ctx.connection;
    const resolved = resolveUpdateCommand(conn);
    const update = resolved?.config ?? null;
    const target = this.o.appVersion;
    let problem: UpdateProblemKind | null = null;
    if (ctx.fileInvalid) problem = 'invalid-file';
    else if (!resolved) problem = conn?.updateProblem ? 'invalid' : conn?.credential ? 'missing' : 'credential-missing';
    const configured = problem === null;
    const command = update?.command ?? (job?.command ?? []);

    let state: UpdateState = job?.state ?? 'idle';
    let readyUntil: string | null = null;
    let confirmation: MachineUpdate['confirmation'] = null;
    const observed = this.o.observedVersion?.(machineId) ?? null;
    if (job && !job.alive && job.kind === 'check' && job.state === 'ready') {
      const until = (job.endedMs ?? 0) + CHECK_VALID_MS;
      if (this.now() <= until && e?.check && update && e.check.commandKey === commandKeyOf(update, conn)) readyUntil = new Date(until).toISOString();
      else state = 'idle';
    }
    if (job && job.kind === 'update' && job.state === 'succeeded') {
      if (observed === target) confirmation = 'confirmed';
      else confirmation = this.now() - (job.endedMs ?? 0) > CONFIRM_WINDOW_MS ? 'diverged' : 'confirming';
    }

    const live = state !== 'idle' ? job : null;
    let key: string | null = null;
    if (problem) key = problem === 'invalid' ? 'problem-invalid' : `problem-${problem}`;
    else if (state === 'ready') key = 'check-ready';
    else if (confirmation === 'confirming') key = 'confirming';
    else if (confirmation === 'diverged') key = 'diverged';
    else if (live?.key && live.state !== 'checking' && live.state !== 'running') key = live.key;
    const remotePort = portOf(command);
    const params: UpdateTextParams = {
      newVersion: target,
      oldCommit: live?.oldCommit ?? null,
      backupPath: live?.backup ?? null,
      port: remotePort,
      n: live?.exitCode ?? null,
      seconds: live?.timeoutSeconds ?? null,
      observed,
      problem: conn?.updateProblem ? renderUpdateText(`invalid-${conn.updateProblem}` as UpdateTextKey) : '?',
    };
    const message = key ? { key, text: renderUpdateText(textKeyOrFallback(key), params) } : null;
    const block = problem === 'invalid' ? buildUpdateBlock(conn?.credential, conn?.checkout) : null;
    return {
      configured,
      source: configured ? resolved!.source : null,
      automatic: live?.automatic ?? false,
      auto: this.autoOf(machineId),
      problem,
      invalidReason: problem === 'invalid' ? (conn?.updateProblem ?? null) : null,
      state,
      kind: live?.kind ?? null,
      phase: live?.phase ?? null,
      targetVersion: target,
      startedAt: live?.startedAt ?? null,
      endedAt: live?.endedAt ?? null,
      exitCode: live?.exitCode ?? null,
      reason: live?.reason ?? null,
      backupPath: live?.backup ?? null,
      oldCommit: live?.oldCommit ?? null,
      newCommit: live?.newCommit ?? null,
      canCancel: job?.alive === true && !job.stopped && job.kind === 'check' && job.phase === 'check',
      timeoutSeconds: update?.timeoutSeconds ?? job?.timeoutSeconds ?? DEFAULT_UPDATE_TIMEOUT_SECONDS,
      command: [...command],
      confirmation,
      observedVersion: observed,
      readyUntil,
      message,
      setup: { block: block?.text ?? null },
    };
  }

  /** The automatic attempt for the app's version: this process's own, else a spent one from the store reads `failed`. */
  private autoOf(machineId: string): AutoAttempt | null {
    const target = this.o.appVersion;
    const a = this.entries.get(machineId)?.auto;
    if (a && a.target === target) return { ...a };
    return this.attempts.spent(machineId) === target ? { target, state: 'failed' } : null;
  }

  private setAuto(machineId: string, state: AutoAttempt['state']): void {
    this.entry(machineId).auto = { target: this.o.appVersion, state };
    this.changed(machineId);
  }

  /** Spends the attempt for the app's version; marks it failed unless this process already has one for it (kept as is). */
  private spendAttempt(machineId: string): void {
    const target = this.o.appVersion;
    this.attempts.spend(machineId, target);
    const e = this.entry(machineId);
    if (e.auto?.target !== target) this.setAuto(machineId, 'failed');
  }

  /**
   * After a good read of the remote's overview (decision 0024 section 2): starts the automatic `--check` when the
   * remote answers a version strictly older than the app's, the app's version has a tag, the machine has a
   * credential and a command, the file is valid, nothing of the machine runs or is starting, and the attempt for
   * this target was not spent. `null` when it does not fire. The attempt is spent before anything runs.
   */
  async considerAuto(machineId: string): Promise<UpdateResult | null> {
    const target = this.o.appVersion;
    const observed = this.o.observedVersion?.(machineId) ?? null;
    if (observed === null) return null;
    const order = compareSemver(observed, target);
    if (order === null || order >= 0) return null;
    if (!refOf(target)) return null;
    const ctx = this.o.context(machineId);
    const conn = ctx.connection;
    if (!conn || ctx.fileInvalid || !conn.credential || !resolveUpdateCommand(conn)) return null;
    if (this.entries.get(machineId)?.job?.alive || this.starting.has(machineId)) return null;
    if (this.attempts.spent(machineId) === target) return null;
    this.attempts.spend(machineId, target);
    this.setAuto(machineId, 'running');
    try {
      const r = await this.start(machineId, 'check', true);
      if (r.kind !== 'started') this.setAuto(machineId, 'failed');
      return r;
    } catch {
      this.setAuto(machineId, 'failed');
      return null;
    }
  }

  check(machineId: string): Promise<UpdateResult> {
    return this.start(machineId, 'check');
  }

  update(machineId: string): Promise<UpdateResult> {
    return this.start(machineId, 'update');
  }

  /** Starts are chained per machine, so two clicks at once reach `begin` one after the other and the second finds the first's job alive. */
  private start(machineId: string, kind: 'check' | 'update', automatic = false): Promise<UpdateResult> {
    const previous = this.starting.get(machineId) ?? Promise.resolve(null);
    const p = previous.catch(() => null).then(() => this.begin(machineId, kind, automatic));
    this.starting.set(machineId, p);
    const clear = () => {
      if (this.starting.get(machineId) === p) this.starting.delete(machineId);
    };
    p.then(clear, clear);
    return p;
  }

  private again(machineId: string): UpdateResult {
    return { kind: 'already-running', update: this.status(machineId)! };
  }

  async cancel(machineId: string): Promise<UpdateResult> {
    await this.starting.get(machineId)?.catch(() => null);
    const looked = await this.o.lookup(machineId);
    if (looked.kind === 'unknown') return { kind: 'unknown' };
    const job = this.entries.get(machineId)?.job;
    if (!job?.alive || job.stopped) return { kind: 'refused', reason: 'not-running' };
    // Only the --check touches nothing; an update's own check phase is the script's first step of a run that goes on to the backup.
    if (job.kind !== 'check' || job.phase !== 'check') return { kind: 'refused', reason: 'not-cancelable' };
    this.stop(machineId, job, 'canceled', 'canceled');
    return { kind: 'canceled', update: this.status(machineId)! };
  }

  private async begin(machineId: string, kind: 'check' | 'update', automatic: boolean): Promise<UpdateResult> {
    const looked = await this.o.lookup(machineId);
    if (looked.kind === 'unknown') return { kind: 'unknown' };
    if (looked.kind === 'invalid-file') return { kind: 'refused', reason: 'invalid-file' };
    const conn = looked.connection;
    const config = resolveUpdateCommand(conn)?.config;
    if (!config) return { kind: 'refused', reason: conn?.updateProblem ? 'invalid' : 'not-configured' };
    const e = this.entry(machineId);
    if (e.job?.alive) {
      if (kind === 'update' && e.job.kind === 'check') return { kind: 'refused', reason: 'check-required' };
      return this.again(machineId);
    }
    const commandKey = commandKeyOf(config, conn);
    if (kind === 'update') {
      const c = e.check;
      if (!c || c.commandKey !== commandKey || this.now() - c.okMs > CHECK_VALID_MS) return { kind: 'refused', reason: 'check-required' };
    }
    const ref = refOf(this.o.appVersion);
    const tail = ref ? buildTail({ ref, telemetryVersion: this.o.telemetryVersion, credentialCommand: Boolean(conn?.credential), check: kind === 'check' }) : null;
    if (!tail) return { kind: 'refused', reason: 'invalid-version' };
    if (kind === 'update') e.check = null;
    // A manual update spends the automatic attempt for this target (decision 0024 section 2).
    if (kind === 'update' && !automatic) this.spendAttempt(machineId);

    const job = this.newJob(kind, config, commandKey, automatic);
    e.job = job;
    this.o.log?.(`update (${machineId}): ${kind} started${automatic ? ' automatic' : ''}`);
    let script: string;
    try {
      script = await (this.o.script ?? readPackagedScript)();
    } catch {
      this.end(machineId, e, job, { state: 'failed', key: 'script-unavailable' }, null);
      return { kind: 'started', update: this.status(machineId)! };
    }
    this.run(machineId, e, job, config, tail, script);
    return { kind: 'started', update: this.status(machineId)! };
  }

  private newJob(kind: 'check' | 'update', config: ReconnectConfig, commandKey: string, automatic: boolean): Job {
    const now = this.now();
    return {
      kind,
      automatic,
      state: kind === 'check' ? 'checking' : 'running',
      key: null,
      // The check is one phase long: it is cancelable from the first instant.
      phase: kind === 'check' ? 'check' : null,
      startedAt: new Date(now).toISOString(),
      startedMs: now,
      endedAt: null,
      endedMs: null,
      exitCode: null,
      reason: null,
      backup: null,
      oldCommit: null,
      newCommit: null,
      result: null,
      child: null,
      alive: true,
      stopped: false,
      timeoutSeconds: kind === 'check' ? CHECK_TIMEOUT_SECONDS : config.timeoutSeconds,
      commandKey,
      command: [...config.command],
      timer: null,
      exited: Promise.resolve(),
    };
  }

  private run(machineId: string, e: Entry, job: Job, config: ReconnectConfig, tail: string[], script: string): void {
    let markExited: () => void = () => {};
    job.exited = new Promise<void>((r) => (markExited = r));
    const done = (code: number | null, spawnFailed = false) => {
      if (!job.alive) return;
      parser.end();
      this.finish(machineId, e, job, code, spawnFailed);
      markExited();
    };
    const parser = new ProgressParser((ev) => {
      if (ev.event === 'phase') {
        if (job.kind === 'check') return;
        if (phaseAdvances(job.phase, ev.phase) && ev.phase !== job.phase) {
          job.phase = ev.phase;
          this.changed(machineId);
        }
      } else job.result = { exit: ev.exit, reason: ev.reason, backup: ev.backup, oldCommit: ev.oldCommit, newCommit: ev.newCommit };
    });
    let child: ChildProcess;
    try {
      child = (this.o.spawn ?? (nodeSpawn as Spawn))(config.command[0]!, [...config.command.slice(1), ...tail], {
        shell: false,
        detached: true,
        stdio: ['pipe', 'pipe', 'ignore'],
        cwd: this.o.cwd ?? homedir(),
        env: reconnectEnv(this.o.env),
        windowsHide: true,
      });
    } catch {
      done(null, true);
      return;
    }
    job.child = child;
    child.unref();
    child.once('error', () => done(null, true));
    child.stdout?.on('data', (chunk: Buffer) => {
      const before = parser.overflow;
      parser.push(chunk);
      // Past the cap before the script is past its check the run is cut; later, the rest is only drained (never kill ssh in the swap).
      if (!before && parser.overflow && job.alive && !job.stopped && !pastCheck(job.phase)) this.stop(machineId, job, 'failed', 'output-too-large');
    });
    child.once('close', (code) => done(code));
    child.stdin?.on('error', () => {});
    child.stdin?.end(script);
    const ms = job.timeoutSeconds * (this.o.msPerSecond ?? 1000);
    job.timer = setTimeout(() => {
      if (!job.alive || job.stopped) return;
      // Killing ssh is safe only for the --check, or before the script ever started (no phase yet).
      if (job.kind === 'check' || job.phase === null) return this.stop(machineId, job, 'timed-out', 'timeout-before-swap');
      // The update's script runs on alone: ssh is left alone and the exit code still decides. A hard cap below ends a hung ssh.
      job.state = 'timed-out';
      job.key = 'timeout-after-swap';
      this.changed(machineId);
      job.timer = setTimeout(() => {
        if (!job.alive) return;
        const pid = job.child?.pid;
        if (pid) signalGroup(pid, 'SIGKILL', job.child);
      }, ms * HARD_CAP_FACTOR);
      job.timer.unref?.();
    }, ms);
    job.timer.unref?.();
    this.changed(machineId);
  }

  /** Our own end of a run: the state changes now; SIGTERM to the group, SIGKILL after the grace. */
  private stop(machineId: string, job: Job, state: UpdateState, key: string): void {
    job.stopped = true;
    job.state = state;
    job.key = key;
    job.endedAt = new Date(this.now()).toISOString();
    job.endedMs = this.now();
    if (job.timer) clearTimeout(job.timer);
    job.timer = null;
    const pid = job.child?.pid;
    if (pid) {
      signalGroup(pid, 'SIGTERM', job.child);
      const kill = setTimeout(() => signalGroup(pid, 'SIGKILL', job.alive ? job.child : null), this.o.killGraceMs ?? UPDATE_KILL_GRACE_MS);
      kill.unref?.();
    }
    this.changed(machineId);
  }

  private finish(machineId: string, e: Entry, job: Job, code: number | null, spawnFailed: boolean): void {
    job.alive = false;
    if (job.timer) clearTimeout(job.timer);
    job.timer = null;
    job.exitCode = code;
    const r = job.result && job.result.exit === code ? job.result : null;
    job.reason = reasonFits(code, r?.reason ?? null);
    job.oldCommit = r?.oldCommit ?? null;
    job.newCommit = r?.newCommit ?? null;
    job.backup = code === 40 || code === 41 ? (r?.backup ?? null) : null;
    if (job.stopped && code !== 0 && code !== 40 && code !== 41) {
      // Canceled, timed out in the check phase or cut for its output: the state we set stands; a clean 130 changes nothing.
      this.end(machineId, e, job, { state: job.state, key: job.key ?? 'unknown-exit' }, code);
      return;
    }
    const c = classify({ exitCode: code, reason: job.reason, phase: job.phase, spawnFailed }, job.kind);
    this.end(machineId, e, job, c, code);
  }

  private end(machineId: string, e: Entry, job: Job, c: { state: UpdateState; key: string }, code: number | null): void {
    job.alive = false;
    job.state = c.state;
    job.key = c.key;
    job.exitCode = code;
    if (job.endedMs === null || !job.stopped) {
      job.endedMs = this.now();
      job.endedAt = new Date(job.endedMs).toISOString();
    }
    if (job.kind === 'check' && c.state === 'ready') e.check = { okMs: job.endedMs, commandKey: job.commandKey };
    else if (job.kind === 'check') e.check = null;
    this.o.log?.(`update (${machineId}): ${job.kind} ${job.state}${job.phase ? ` at ${job.phase}` : ''}${code === null ? '' : ` exit ${code}`}`);
    this.changed(machineId);
    // 21 (no credential command) and 22 (needs --allow-disconnect) never lead to an update: they spend the attempt.
    if (code === 21 || code === 22) this.spendAttempt(machineId);
    if (job.automatic) {
      if (job.kind === 'check' && c.state === 'ready') {
        // The good check pays for the update at once; no confirm window, which exists for the person.
        this.start(machineId, 'update', true).then(
          (r) => {
            if (r.kind !== 'started') this.setAuto(machineId, 'failed');
          },
          () => this.setAuto(machineId, 'failed'),
        );
      } else this.setAuto(machineId, job.kind === 'update' && c.state === 'succeeded' ? 'succeeded' : 'failed');
    }
    if (job.kind === 'update' && c.state === 'succeeded') {
      // The remote core restarted: its credentials are gone. Drop ours and read it now, not in 30 s (decision 0022 section 5).
      void Promise.resolve(this.o.onUpdated?.(machineId))
        .catch(() => undefined)
        .finally(() => this.changed(machineId));
    }
  }

  private changed(machineId: string): void {
    this.o.onChange?.(machineId);
  }
}

/** The remote core's `--port` in the declared command, for the texts; `null` when absent. */
function portOf(command: readonly string[]): string | null {
  const at = command.indexOf('--port');
  const v = at >= 0 ? command[at + 1] : undefined;
  return v !== undefined && PORT_ARG.test(v) ? v : null;
}


/** What a check is good for: the declared command and whether the Mac declares a credential command to the script. */
function commandKeyOf(config: ReconnectConfig, conn: ConnectionConfig | null | undefined): string {
  return JSON.stringify([config.command, Boolean(conn?.credential)]);
}
