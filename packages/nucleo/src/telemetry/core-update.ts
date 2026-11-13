// The Update button's job, Mac side (issue 462, decision 0022). What this module guarantees:
//
// - Only what the user declared runs. The command is `connection.update.command` of the FRESHEST reading of
//   machines.json (`lookup`, which refreshes it); while the file is invalid nothing runs. The núcleo appends the
//   closed tail of core-update-protocol.ts (`--ref`, `--mac-telemetry-version`, `--mac-credential-command`,
//   `--progress json`, and `--check` for the check step) and nothing else: no text of the request reaches the argv
//   (the routes pass the machine id only), and `--allow-disconnect` never appears (the validator refuses it in the
//   declared command too, machines-config.ts `parseUpdate`).
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
// - The log gets one line per end, `update (<id>): <kind> <state> exit <n>`; never the output nor the script.

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { buildUpdateBlock } from './core-update-block.ts';
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

export type UpdateRefusal = 'invalid-file' | 'not-configured' | 'invalid' | 'invalid-version' | 'check-required' | 'not-cancelable' | 'not-running';

export type UpdateProblemKind = 'missing' | 'invalid' | 'credential-missing' | 'invalid-file';

export interface MachineUpdate {
  /** There is a valid `connection.update` and machines.json parses. */
  configured: boolean;
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
  /** When `problem` is `missing` or `invalid` and the credential allows it: the block to paste (the núcleo never writes the file). */
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
}

interface Job {
  kind: 'check' | 'update';
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

  constructor(options: CoreUpdaterOptions) {
    this.o = options;
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  private entry(id: string): Entry {
    let e = this.entries.get(id);
    if (!e) this.entries.set(id, (e = { job: null, check: null }));
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
    const update = conn?.update ?? null;
    const target = this.o.appVersion;
    let problem: UpdateProblemKind | null = null;
    if (ctx.fileInvalid) problem = 'invalid-file';
    else if (!update) problem = conn?.updateProblem ? 'invalid' : conn?.credential ? 'missing' : 'credential-missing';
    const configured = problem === null;
    const command = update?.command ?? (job?.command ?? []);

    let state: UpdateState = job?.state ?? 'idle';
    let readyUntil: string | null = null;
    let confirmation: MachineUpdate['confirmation'] = null;
    const observed = this.o.observedVersion?.(machineId) ?? null;
    if (job && !job.alive && job.kind === 'check' && job.state === 'ready') {
      const until = (job.endedMs ?? 0) + CHECK_VALID_MS;
      if (this.now() <= until && e?.check) readyUntil = new Date(until).toISOString();
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
    const block = problem === 'missing' || problem === 'invalid' ? buildUpdateBlock(conn?.credential, conn?.checkout) : null;
    return {
      configured,
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
      canCancel: job?.alive === true && !job.stopped && job.phase === 'check',
      timeoutSeconds: update?.timeoutSeconds ?? job?.timeoutSeconds ?? DEFAULT_UPDATE_TIMEOUT_SECONDS,
      command: [...command],
      confirmation,
      observedVersion: observed,
      readyUntil,
      message,
      setup: { block: block?.text ?? null },
    };
  }

  check(machineId: string): Promise<UpdateResult> {
    return this.start(machineId, 'check');
  }

  update(machineId: string): Promise<UpdateResult> {
    return this.start(machineId, 'update');
  }

  /** Starts are chained per machine, so two clicks at once reach `begin` one after the other and the second finds the first's job alive. */
  private start(machineId: string, kind: 'check' | 'update'): Promise<UpdateResult> {
    const previous = this.starting.get(machineId) ?? Promise.resolve(null);
    const p = previous.catch(() => null).then(() => this.begin(machineId, kind));
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
    if (job.phase !== 'check') return { kind: 'refused', reason: 'not-cancelable' };
    this.stop(machineId, job, 'canceled', 'canceled');
    return { kind: 'canceled', update: this.status(machineId)! };
  }

  private async begin(machineId: string, kind: 'check' | 'update'): Promise<UpdateResult> {
    const looked = await this.o.lookup(machineId);
    if (looked.kind === 'unknown') return { kind: 'unknown' };
    if (looked.kind === 'invalid-file') return { kind: 'refused', reason: 'invalid-file' };
    const conn = looked.connection;
    const config = conn?.update;
    if (!config) return { kind: 'refused', reason: conn?.updateProblem ? 'invalid' : 'not-configured' };
    const e = this.entry(machineId);
    if (e.job?.alive) {
      if (kind === 'update' && e.job.kind === 'check') return { kind: 'refused', reason: 'check-required' };
      return this.again(machineId);
    }
    const commandKey = JSON.stringify(config.command);
    if (kind === 'update') {
      const c = e.check;
      if (!c || c.commandKey !== commandKey || this.now() - c.okMs > CHECK_VALID_MS) return { kind: 'refused', reason: 'check-required' };
    }
    const ref = refOf(this.o.appVersion);
    const tail = ref ? buildTail({ ref, telemetryVersion: this.o.telemetryVersion, credentialCommand: Boolean(conn?.credential), check: kind === 'check' }) : null;
    if (!tail) return { kind: 'refused', reason: 'invalid-version' };
    if (kind === 'update') e.check = null;

    const job = this.newJob(kind, config, commandKey);
    e.job = job;
    this.o.log?.(`update (${machineId}): ${kind} started`);
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

  private newJob(kind: 'check' | 'update', config: ReconnectConfig, commandKey: string): Job {
    const now = this.now();
    return {
      kind,
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
      if (pastCheck(job.phase)) {
        // The script runs on alone: ssh is left alone, and the exit code still decides.
        job.state = 'timed-out';
        job.key = 'timeout-after-swap';
        this.changed(machineId);
      } else this.stop(machineId, job, 'timed-out', 'timeout-before-swap');
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
    if (job.stopped) {
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

