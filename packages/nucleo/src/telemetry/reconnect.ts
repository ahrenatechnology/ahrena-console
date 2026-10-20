// Reconnect a remote machine by running the command the user wrote in machines.json (#244, decision
// 0012 section 3). What this module guarantees:
//
// - The command comes only from the freshest reading of the file (`lookup`, which refreshes it): a
//   command removed from the file does not run, even if the screen still shows the button. Nothing
//   from the request reaches the process; the routes pass only the machine id.
// - `spawn(command[0], command.slice(1), { shell: false, detached: true })`: no shell, no expansion,
//   its own process group (so the timeout and Cancel reach the script's children too), standard input
//   closed (a command that asks something in a terminal fails instead of hanging), the user's home
//   folder as the working directory, and the core's environment minus the console's own variables
//   (`AHRENA_CONSOLE_*` and the old names, `reconnectEnv`).
// - One per machine: a second start, from anywhere, gets the one running (also while a canceled or
//   timed-out process is still dying).
// - Timeout (`timeoutSeconds`, 180 by default) and Cancel: SIGTERM to the process group, SIGKILL to the
//   group 5 s later. The state changes at once (`timed-out`, `canceled`).
// - The process exiting on its own: `succeeded` on 0 (and the machine is read at once, `onSucceeded`),
//   `failed` otherwise, with the exit code (`null` when a signal ended it). The process group is left
//   alone after a normal exit: a script that leaves a tunnel running in the background keeps it.
// - A spawn error (ENOENT, EACCES): `failed`, exit code `null`, one log line with the error code.
// - The output (stdout and stderr) goes ONLY to `reconnect.log` in the installation's data folder,
//   mode 0600, one line per output line with the ISO time, the machine id and the stream, rotated to
//   `reconnect.log.1` past 1 MB. It may carry a device code, an account name or a path, so it never
//   reaches the API, and the console log gets only a one-line start and end summary.
// - Every state change calls `onChange(id)`; `publishReconnectChanges` turns it into an `alert`
//   change keyed `<machine>:reconnect` on /api/changes, which the machine screen's `touchesMachine`
//   and the app's machine list already re-read on.

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { appendFileSync, chmodSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ChangeCursor } from '../changes/cursor.ts';
import type { ReconnectConfig } from './machines-config.ts';
import type { ReconnectStarter, ReconnectState, ReconnectStatus } from './model.ts';

export const RECONNECT_LOG_FILE = 'reconnect.log';
export const MAX_RECONNECT_LOG_BYTES = 1024 * 1024;
export const RECONNECT_KILL_GRACE_MS = 5_000;
/** A longer output line is cut here, so one runaway line never fills the log. */
const MAX_LINE = 4_096;

/** The old names of the console's variables (decision 0009), still accepted somewhere in the repo. */
const LEGACY_ENV = new Set(['AHRENA_ABRIR_MENU', 'AHRENA_DADOS_DIR', 'AHRENA_NODE', 'AHRENA_ORIGEM']);

/** The environment for the user's command: the core's, minus the console's own variables. */
export function reconnectEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith('AHRENA_CONSOLE_') || k.startsWith('AHRENA_NUCLEO_') || LEGACY_ENV.has(k)) continue;
    out[k] = v;
  }
  return out;
}

export function reconnectLogFile(dataDir: string): string {
  return join(dataDir, RECONNECT_LOG_FILE);
}

export type StartResult = { kind: 'unknown' } | { kind: 'not-configured' } | { kind: 'started' | 'already-running'; status: ReconnectStatus };
export type CancelResult = { kind: 'unknown' } | { kind: 'not-running' } | { kind: 'canceled'; status: ReconnectStatus };

/** What the routes need (src/api/telemetry.ts). */
export interface ReconnectControl {
  start(machineId: string, startedBy: ReconnectStarter): Promise<StartResult>;
  cancel(machineId: string): Promise<CancelResult>;
}

type Spawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface ReconnectRunnerOptions {
  logFile: string;
  /** The freshest reconnect of a machine (refreshing machines.json first): `undefined` = unknown id, `null` = no command. */
  lookup: (machineId: string) => Promise<ReconnectConfig | null | undefined>;
  onSucceeded?: (machineId: string) => void;
  onChange?: (machineId: string) => void;
  /** Tests: counts the spawns. */
  onSpawn?: (machineId: string) => void;
  spawn?: Spawn;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  now?: () => number;
  /** Tests shorten the time unit; 1000 in production. */
  msPerSecond?: number;
  killGraceMs?: number;
  maxLogBytes?: number;
  log?: (message: string) => void;
}

interface Run {
  state: ReconnectState;
  startedAt: string;
  startedMs: number;
  endedAt: string | null;
  exitCode: number | null;
  startedBy: ReconnectStarter;
  /** The command and timeout this run started with. */
  config: ReconnectConfig;
  child: ChildProcess | null;
  alive: boolean;
  exited: Promise<void>;
  timer: ReturnType<typeof setTimeout> | null;
}

export class ReconnectRunner implements ReconnectControl {
  readonly logFile: string;
  private readonly o: ReconnectRunnerOptions;
  private readonly runs = new Map<string, Run>();
  private readonly starting = new Map<string, Promise<StartResult>>();
  private logReady = false;

  constructor(options: ReconnectRunnerOptions) {
    this.o = options;
    this.logFile = options.logFile;
  }

  /** The machine's reconnect for `GET /api/machines`, with the configured command (or `null`). */
  status(machineId: string, config: ReconnectConfig | null): ReconnectStatus {
    const run = this.runs.get(machineId);
    return {
      configured: config !== null,
      command: config ? [...config.command] : null,
      timeoutSeconds: config ? config.timeoutSeconds : null,
      state: run?.state ?? 'idle',
      startedAt: run?.startedAt ?? null,
      endedAt: run?.endedAt ?? null,
      exitCode: run?.exitCode ?? null,
      startedBy: run?.startedBy ?? null,
      logFile: this.logFile,
    };
  }

  /** Resolves when the machine's process (if any) has exited. */
  async exited(machineId: string): Promise<void> {
    await this.starting.get(machineId)?.catch(() => null);
    await this.runs.get(machineId)?.exited;
  }

  start(machineId: string, startedBy: ReconnectStarter): Promise<StartResult> {
    const active = this.runs.get(machineId);
    if (active?.alive) return Promise.resolve(this.alreadyRunning(machineId));
    const pending = this.starting.get(machineId);
    if (pending) return pending.then((r) => (r.kind === 'started' ? this.alreadyRunning(machineId) : r));
    const p = this.begin(machineId, startedBy).finally(() => this.starting.delete(machineId));
    this.starting.set(machineId, p);
    return p;
  }

  async cancel(machineId: string): Promise<CancelResult> {
    await this.starting.get(machineId)?.catch(() => null);
    const run = this.runs.get(machineId);
    if (run?.alive && run.state === 'running') {
      this.stopRun(machineId, run, 'canceled');
      return { kind: 'canceled', status: await this.currentStatus(machineId) };
    }
    if (run?.alive) return { kind: 'canceled', status: await this.currentStatus(machineId) };
    return (await this.o.lookup(machineId)) === undefined ? { kind: 'unknown' } : { kind: 'not-running' };
  }

  private async currentStatus(machineId: string): Promise<ReconnectStatus> {
    const config = await this.o.lookup(machineId).catch(() => null);
    return this.status(machineId, config ?? null);
  }

  private alreadyRunning(machineId: string): StartResult {
    const run = this.runs.get(machineId)!;
    return { kind: 'already-running', status: this.status(machineId, run.config) };
  }

  private async begin(machineId: string, startedBy: ReconnectStarter): Promise<StartResult> {
    const config = await this.o.lookup(machineId);
    if (config === undefined) return { kind: 'unknown' };
    if (config === null) return { kind: 'not-configured' };
    const now = (this.o.now ?? Date.now)();
    let markExited: () => void = () => {};
    const run: Run = {
      state: 'running',
      startedAt: new Date(now).toISOString(),
      startedMs: now,
      endedAt: null,
      exitCode: null,
      startedBy,
      config,
      child: null,
      alive: true,
      exited: new Promise<void>((r) => (markExited = r)),
      timer: null,
    };
    this.runs.set(machineId, run);
    this.o.log?.(`reconnect (${machineId}): started by ${startedBy === 'ui' ? 'the /ui' : 'a local client'}`);
    this.writeLog(machineId, 'core', `start (${startedBy})`);

    const finish = (state: ReconnectState, exitCode: number | null) => {
      if (!run.alive) return;
      run.alive = false;
      if (run.timer) clearTimeout(run.timer);
      if (run.state === 'running') {
        run.state = state;
        run.endedAt = new Date((this.o.now ?? Date.now)()).toISOString();
      }
      run.exitCode = exitCode;
      const seconds = Math.round(((this.o.now ?? Date.now)() - run.startedMs) / 1000);
      this.o.log?.(`reconnect (${machineId}): ${run.state}${exitCode === null ? '' : ` (exit ${exitCode})`} after ${seconds} s`);
      this.writeLog(machineId, 'core', `end ${run.state}${exitCode === null ? '' : ` exit ${exitCode}`}`);
      markExited();
      this.o.onChange?.(machineId);
      if (run.state === 'succeeded') this.o.onSucceeded?.(machineId);
    };

    let child: ChildProcess;
    try {
      child = (this.o.spawn ?? (nodeSpawn as Spawn))(config.command[0]!, config.command.slice(1), {
        shell: false,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: this.o.cwd ?? homedir(),
        env: this.o.env ?? reconnectEnv(),
        windowsHide: true,
      });
    } catch (err) {
      this.o.log?.(`reconnect (${machineId}): could not start (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
      finish('failed', null);
      return { kind: 'started', status: this.status(machineId, config) };
    }
    this.o.onSpawn?.(machineId);
    run.child = child;
    child.unref();
    this.pipe(machineId, child.stdout, 'stdout');
    this.pipe(machineId, child.stderr, 'stderr');
    child.once('error', (err: NodeJS.ErrnoException) => {
      this.o.log?.(`reconnect (${machineId}): could not start (${err.code ?? 'error'})`);
      finish('failed', null);
    });
    child.once('exit', (code) => finish(code === 0 ? 'succeeded' : 'failed', code));
    const ms = config.timeoutSeconds * (this.o.msPerSecond ?? 1000);
    run.timer = setTimeout(() => {
      if (run.alive && run.state === 'running') this.stopRun(machineId, run, 'timed-out');
    }, ms);
    run.timer.unref?.();
    this.o.onChange?.(machineId);
    return { kind: 'started', status: this.status(machineId, config) };
  }

  /** Timeout or Cancel: the state changes now; SIGTERM to the group, SIGKILL to the group after the grace. */
  private stopRun(machineId: string, run: Run, state: 'timed-out' | 'canceled'): void {
    run.state = state;
    run.endedAt = new Date((this.o.now ?? Date.now)()).toISOString();
    if (run.timer) clearTimeout(run.timer);
    run.timer = null;
    this.o.log?.(`reconnect (${machineId}): ${state === 'canceled' ? 'canceled' : 'past the timeout'}; ending the process group`);
    const pid = run.child?.pid;
    if (pid) {
      signalGroup(pid, 'SIGTERM', run.child!);
      const kill = setTimeout(() => signalGroup(pid, 'SIGKILL', run.alive ? run.child! : null), this.o.killGraceMs ?? RECONNECT_KILL_GRACE_MS);
      kill.unref?.();
    }
    this.o.onChange?.(machineId);
  }

  private pipe(machineId: string, stream: NodeJS.ReadableStream | null, name: 'stdout' | 'stderr'): void {
    if (!stream) return;
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      buffer += chunk;
      let i: number;
      while ((i = buffer.indexOf('\n')) >= 0) {
        this.writeLog(machineId, name, buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
      }
      if (buffer.length > MAX_LINE) {
        this.writeLog(machineId, name, buffer);
        buffer = '';
      }
    });
    stream.on('end', () => {
      if (buffer) this.writeLog(machineId, name, buffer);
      buffer = '';
    });
    stream.on('error', () => undefined);
  }

  /** One line in reconnect.log (0600, rotated past the limit). A write error is logged once per run, without the line. */
  private writeLog(machineId: string, stream: string, text: string): void {
    const line = `${new Date((this.o.now ?? Date.now)()).toISOString()} ${machineId} ${stream}: ${text.replace(/\r$/, '').slice(0, MAX_LINE).replace(/[\r\n]/g, ' ')}\n`;
    try {
      if (!this.logReady) {
        mkdirSync(dirname(this.logFile), { recursive: true, mode: 0o700 });
      }
      let size = 0;
      try {
        size = statSync(this.logFile).size;
      } catch {
        size = 0;
      }
      if (size > 0 && size + Buffer.byteLength(line) > (this.o.maxLogBytes ?? MAX_RECONNECT_LOG_BYTES)) {
        renameSync(this.logFile, `${this.logFile}.1`);
        chmodSync(`${this.logFile}.1`, 0o600);
      }
      appendFileSync(this.logFile, line, { mode: 0o600 });
      if (!this.logReady) {
        chmodSync(this.logFile, 0o600);
        this.logReady = true;
      }
    } catch (err) {
      this.o.log?.(`reconnect (${machineId}): could not write ${this.logFile} (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
    }
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals, child: ChildProcess | null): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child?.kill(signal);
    } catch {
      // already gone
    }
  }
}

/** Each reconnect state change as an `alert` change keyed `<machine>:reconnect` (machine screen's `touchesMachine`). */
export function publishReconnectChanges(cursor: ChangeCursor): (machineId: string) => void {
  return (machineId) => {
    cursor.record({ type: 'alert', key: `${machineId}:reconnect`, sessionId: null, accountId: null });
  };
}
