// Reconnect a remote machine by running the command the user wrote in machines.json (#244, decision
// 0012 section 3). What this module guarantees:
//
// - The command comes only from the freshest reading of the file (`lookup`, which refreshes it): a
//   command removed from the file does not run, even if the screen still shows the button. While the
//   file is invalid (its last refresh did not parse), nothing runs either, even if the last good
//   reading had a command (`invalid-file`, 409). Nothing from the request reaches the process; the
//   routes pass only the machine id.
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
// - The output (stdout and stderr) goes ONLY to `reconnect.log` in the installation's data folder:
//   the core opens it (append, mode 0600, rotated to `reconnect.log.1` first when past 1 MB) and hands
//   that file descriptor to the child as its stdout AND stderr, then closes its own copy. The core
//   never reads the output: no pipe, no per-line work, and a tunnel the script leaves in the
//   background keeps writing to the file after the script exits and after the core restarts (no
//   SIGPIPE). The core writes one header line before spawning (ISO time, machine id, `start`, who
//   started it) and one footer line on exit (state, exit code, duration). If the log cannot be
//   opened, one line goes to the console log and the command runs with its output discarded
//   (`stdio: 'ignore'`). The output may carry a device code, an account name or a path, so it never
//   reaches the API, and the console log gets only a one-line start and end summary.
// - Every state change calls `onChange(id)`; `publishReconnectChanges` turns it into an `alert`
//   change keyed `<machine>:reconnect` on /api/changes, which the machine screen's `touchesMachine`
//   and the app's machine list already re-read on.

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { appendFileSync, chmodSync, closeSync, fchmodSync, fstatSync, mkdirSync, openSync, readSync, renameSync, statSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ChangeCursor } from '../changes/cursor.ts';
import type { ReconnectConfig } from './machines-config.ts';
import type { ReconnectStarter, ReconnectState, ReconnectStatus } from './model.ts';

export const RECONNECT_LOG_FILE = 'reconnect.log';
export const MAX_RECONNECT_LOG_BYTES = 1024 * 1024;
export const RECONNECT_KILL_GRACE_MS = 5_000;
/** What `lookup` answers while machines.json is invalid: nothing runs until it is fixed. */
export const INVALID_MACHINES_FILE = 'invalid-file';

/** The environment for the user's command: the core's, minus the console's own variables. */
export function reconnectEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith('AHRENA_CONSOLE_')) continue;
    out[k] = v;
  }
  return out;
}

export function reconnectLogFile(dataDir: string): string {
  return join(dataDir, RECONNECT_LOG_FILE);
}

export type StartResult =
  | { kind: 'unknown' }
  | { kind: 'not-configured' }
  | { kind: 'invalid-file' }
  | { kind: 'started' | 'already-running'; status: ReconnectStatus };
export type CancelResult = { kind: 'unknown' } | { kind: 'not-running' } | { kind: 'canceled'; status: ReconnectStatus };

/** What the routes need (src/api/telemetry.ts). */
export interface ReconnectControl {
  start(machineId: string, startedBy: ReconnectStarter): Promise<StartResult>;
  cancel(machineId: string): Promise<CancelResult>;
}

type Spawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface ReconnectRunnerOptions {
  logFile: string;
  /**
   * The freshest reconnect of a machine (refreshing machines.json first): `undefined` = unknown id,
   * `null` = no command, `INVALID_MACHINES_FILE` = the file is invalid right now.
   */
  lookup: (machineId: string) => Promise<ReconnectConfig | null | undefined | typeof INVALID_MACHINES_FILE>;
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
    return this.status(machineId, typeof config === 'object' && config !== null ? config : (this.runs.get(machineId)?.config ?? null));
  }

  private alreadyRunning(machineId: string): StartResult {
    const run = this.runs.get(machineId)!;
    return { kind: 'already-running', status: this.status(machineId, run.config) };
  }

  private async begin(machineId: string, startedBy: ReconnectStarter): Promise<StartResult> {
    const config = await this.o.lookup(machineId);
    if (config === undefined) return { kind: 'unknown' };
    if (config === null) return { kind: 'not-configured' };
    if (config === INVALID_MACHINES_FILE) return { kind: 'invalid-file' };
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
    const fd = this.openLog(machineId, `start (${startedBy})`);

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
      this.footer(machineId, `end ${run.state} exit ${exitCode === null ? 'none' : exitCode} after ${seconds} s`, fd !== null);
      markExited();
      this.o.onChange?.(machineId);
      if (run.state === 'succeeded') this.o.onSucceeded?.(machineId);
    };

    let child: ChildProcess;
    try {
      child = (this.o.spawn ?? (nodeSpawn as Spawn))(config.command[0]!, config.command.slice(1), {
        shell: false,
        detached: true,
        stdio: fd === null ? 'ignore' : ['ignore', fd, fd],
        cwd: this.o.cwd ?? homedir(),
        env: this.o.env ?? reconnectEnv(),
        windowsHide: true,
      });
    } catch (err) {
      closeQuietly(fd);
      this.o.log?.(`reconnect (${machineId}): could not start (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
      finish('failed', null);
      return { kind: 'started', status: this.status(machineId, config) };
    }
    // The child has its own copy of the descriptor; the core keeps none.
    closeQuietly(fd);
    this.o.onSpawn?.(machineId);
    run.child = child;
    child.unref();
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

  /**
   * Opens reconnect.log for the child (append, 0600; rotated to `.1` first when past the limit) and
   * writes the header line. `null`, with one console log line, when it cannot: the output is discarded.
   */
  private openLog(machineId: string, header: string): number | null {
    return openRunLog(this.logFile, runLogLine(this.o.now ?? Date.now, machineId, header), {
      maxBytes: this.o.maxLogBytes,
      onError: (code) => this.o.log?.(`reconnect (${machineId}): could not open ${this.logFile} (${code}); the output is discarded`),
    });
  }

  /** The footer line, appended by the core on exit; silent when the log could not be opened at the start. */
  private footer(machineId: string, text: string, logOpen: boolean): void {
    if (!logOpen) return;
    appendRunLogLine(this.logFile, runLogLine(this.o.now ?? Date.now, machineId, text), (code) =>
      this.o.log?.(`reconnect (${machineId}): could not write ${this.logFile} (${code})`),
    );
  }
}

// The run-log mechanics, shared with the cloud connectors' logins (src/clouds/aws-login.ts, #277):
// the same file, the same rotation, mode and header/footer lines, the same process-group signals.

/** One line of the run log: ISO time, the target (a machine id, `aws:<session>`), the text. */
export function runLogLine(now: () => number, target: string, text: string): string {
  return `${new Date(now()).toISOString()} ${target} ${text}\n`;
}

/**
 * Opens the run log for a child (append, 0600; rotated to `.1` first when past `maxBytes`) and
 * writes `header`. `null` when it cannot (`onError` gets the error code once): the output is discarded.
 */
export function openRunLog(logFile: string, header: string, o: { maxBytes?: number | undefined; onError?: (code: string) => void } = {}): number | null {
  try {
    mkdirSync(dirname(logFile), { recursive: true, mode: 0o700 });
    let size = 0;
    try {
      size = statSync(logFile).size;
    } catch {
      size = 0;
    }
    if (size > (o.maxBytes ?? MAX_RECONNECT_LOG_BYTES)) {
      renameSync(logFile, `${logFile}.1`);
      chmodSync(`${logFile}.1`, 0o600);
    }
    const fd = openSync(logFile, 'a', 0o600);
    try {
      fchmodSync(fd, 0o600);
      writeSync(fd, header);
    } catch (err) {
      closeQuietly(fd);
      throw err;
    }
    return fd;
  } catch (err) {
    o.onError?.((err as NodeJS.ErrnoException).code ?? 'error');
    return null;
  }
}

/** Appends a core line (a footer) to the run log, on a line of its own: the command's last line may lack its newline. */
export function appendRunLogLine(logFile: string, line: string, onError?: (code: string) => void): void {
  try {
    appendFileSync(logFile, `${endsWithNewline(logFile) ? '' : '\n'}${line}`, { mode: 0o600 });
  } catch (err) {
    onError?.((err as NodeJS.ErrnoException).code ?? 'error');
  }
}

function endsWithNewline(file: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    if (size === 0) return true;
    const b = Buffer.alloc(1);
    readSync(fd, b, 0, 1, size - 1);
    return b[0] === 0x0a;
  } catch {
    return true;
  } finally {
    closeQuietly(fd);
  }
}

export function closeQuietly(fd: number | null): void {
  if (fd === null) return;
  try {
    closeSync(fd);
  } catch {
    // already closed
  }
}

/** A signal to the whole process group of `pid`; to the child alone when the group is gone. */
export function signalGroup(pid: number, signal: NodeJS.Signals, child: ChildProcess | null): void {
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
