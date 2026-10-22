// The AWS connector's login (#277, decision 0013 sections 1, 2 and 2a): `aws sso login` for one SSO
// session, run with the mechanics of the reconnect runner (src/telemetry/reconnect.ts) and into the
// same `reconnect.log`.
//
// - The argv is a fixed template written here (`loginArgv`); the only variable part is the session
//   (or legacy profile) name, which comes from the freshest reading of ~/.aws/config (`lookup`) and
//   has matched `SAFE_CLI_NAME`. Nothing from the request reaches the process but the mode, a fixed enum.
// - `spawn` without shell, its own process group, stdin closed, the user's home as cwd, the núcleo's
//   environment minus `AHRENA_CONSOLE_*`; 300 s timeout; one login per session (a second start gets
//   the one running); Cancel and the timeout send SIGTERM to the group, SIGKILL 5 s later.
// - `browser` mode: the CLI opens the browser; stdout and stderr go straight to reconnect.log through
//   its file descriptor, and the núcleo reads nothing.
// - `device-code` mode (the remote núcleo, section 2a): `--use-device-code --no-browser`. stderr goes
//   straight to the log; stdout comes through a pipe so the núcleo can pick out, by strict pattern,
//   ONLY the verification URI (https on an AWS host) and the user code (`ABCD-EFGH`). Every byte of
//   stdout is still written to the log, as it arrives; nothing else of it is kept. While the process
//   waits, the status carries `deviceCode: { verificationUri, userCode, expiresAt }` (10 min, or
//   the timeout if sooner); it is dropped as soon as the run ends.
// - The console log gets only a one-line start and end summary, with the session name and no output.

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { appendRunLogLine, closeQuietly, openRunLog, reconnectEnv, RECONNECT_KILL_GRACE_MS, runLogLine, signalGroup } from '../telemetry/reconnect.ts';
import type { AwsSsoSession } from './aws-config.ts';

export const LOGIN_TIMEOUT_SECONDS = 300;
/** How long an AWS device code lives. */
export const DEVICE_CODE_TTL_MS = 10 * 60 * 1000;
/** Only the start of stdout is scanned for the code (the CLI prints it in the first lines). */
const MAX_SCAN_CHARS = 16 * 1024;

export const LOGIN_MODES = ['browser', 'device-code'] as const;
export type LoginMode = (typeof LOGIN_MODES)[number];
export type LoginState = 'idle' | 'running' | 'succeeded' | 'failed' | 'timed-out' | 'canceled';
export type LoginStarter = 'ui' | 'local';

export interface DeviceCode {
  verificationUri: string;
  userCode: string;
  expiresAt: string;
}

export interface LoginStatus {
  state: LoginState;
  mode: LoginMode | null;
  startedAt: string | null;
  endedAt: string | null;
  timeoutSeconds: number;
  exitCode: number | null;
  startedBy: LoginStarter | null;
  logFile: string;
  deviceCode: DeviceCode | null;
}

/** The fixed argv of a login. */
export function loginArgv(aws: string, session: Pick<AwsSsoSession, 'name' | 'kind'>, mode: LoginMode): string[] {
  const target = session.kind === 'sso-session' ? ['--sso-session', session.name] : ['--profile', session.name];
  return [aws, 'sso', 'login', ...target, ...(mode === 'device-code' ? ['--use-device-code', '--no-browser'] : [])];
}

const AWS_HOST = /(^|\.)(awsapps\.com|amazonaws\.com|aws)$/;
export const USER_CODE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;

/** A verification URI the screen may show: https, an AWS host (`*.awsapps.com`, `*.amazonaws.com`, `*.aws`), no credentials, no port. */
export function acceptVerificationUri(candidate: string): string | null {
  if (candidate.length > 512) return null;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const host = url.hostname;
  if (!host.includes('.') || !AWS_HOST.test(host) || !/^[a-z0-9.-]+$/.test(host)) return null;
  return url.href;
}

/**
 * The Mac's check on a remote núcleo's device code (decision 0013 §2a, review of #310): the
 * verification URL must be on that session's own portal (`startUrlHost`) or on the SSO device page
 * of that session's region (`device.sso.<region>.amazonaws.com`). It closes the cheap path of a
 * process squatting the tunnel port and serving any AWS URL; a full impostor is #315's (pairing).
 */
export function deviceCodeOnSessionPortal(verificationUri: string, startUrlHost: string | null, region: string | null): boolean {
  let host: string;
  try {
    host = new URL(verificationUri).hostname;
  } catch {
    return false;
  }
  if (startUrlHost && host === startUrlHost.toLowerCase()) return true;
  return !!region && /^[a-z0-9-]{1,32}$/.test(region) && host === `device.sso.${region}.amazonaws.com`;
}

/** The first accepted URI and the first user code in the CLI's stdout; anything else is ignored. */
export function extractDeviceCode(stdout: string): { verificationUri: string | null; userCode: string | null } {
  let verificationUri: string | null = null;
  let userCode: string | null = null;
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!userCode && USER_CODE.test(line)) userCode = line;
    if (!verificationUri) {
      for (const m of line.matchAll(/https:\/\/[^\s"'<>]+/g)) {
        const ok = acceptVerificationUri(m[0]);
        if (ok) {
          verificationUri = ok;
          break;
        }
      }
    }
  }
  return { verificationUri, userCode };
}

export interface LoginTarget {
  argv: string[];
  timeoutSeconds?: number;
}

export type LoginLookup = { kind: 'ok'; target: LoginTarget } | { kind: 'refused'; reason: string };

export type LoginStartResult = { kind: 'started' | 'already-running'; status: LoginStatus } | { kind: 'refused'; reason: string };
export type LoginCancelResult = { kind: 'not-running' } | { kind: 'canceled'; status: LoginStatus };

type Spawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface AwsLoginRunnerOptions {
  logFile: string;
  /** Tests count the spawns. */
  onSpawn?: (session: string, argv: readonly string[]) => void;
  onChange?: (session: string) => void;
  onSucceeded?: (session: string) => void;
  spawn?: Spawn;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  now?: () => number;
  msPerSecond?: number;
  killGraceMs?: number;
  maxLogBytes?: number;
  log?: (message: string) => void;
}

interface Run {
  state: LoginState;
  mode: LoginMode;
  startedAt: string;
  startedMs: number;
  endedAt: string | null;
  exitCode: number | null;
  startedBy: LoginStarter;
  timeoutSeconds: number;
  child: ChildProcess | null;
  alive: boolean;
  exited: Promise<void>;
  timer: ReturnType<typeof setTimeout> | null;
  deviceCode: DeviceCode | null;
}

export class AwsLoginRunner {
  readonly logFile: string;
  private readonly o: AwsLoginRunnerOptions;
  private readonly runs = new Map<string, Run>();

  constructor(options: AwsLoginRunnerOptions) {
    this.o = options;
    this.logFile = options.logFile;
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  status(session: string): LoginStatus {
    const run = this.runs.get(session);
    return {
      state: run?.state ?? 'idle',
      mode: run?.mode ?? null,
      startedAt: run?.startedAt ?? null,
      endedAt: run?.endedAt ?? null,
      timeoutSeconds: run?.timeoutSeconds ?? LOGIN_TIMEOUT_SECONDS,
      exitCode: run?.exitCode ?? null,
      startedBy: run?.startedBy ?? null,
      logFile: this.logFile,
      deviceCode: run?.state === 'running' && run.deviceCode ? { ...run.deviceCode } : null,
    };
  }

  running(session: string): boolean {
    return this.runs.get(session)?.alive === true;
  }

  async exited(session: string): Promise<void> {
    await this.runs.get(session)?.exited;
  }

  /** Starts the login (`target` comes from the caller's fresh lookup), or returns the one running. */
  start(session: string, mode: LoginMode, startedBy: LoginStarter, lookup: () => LoginLookup): LoginStartResult {
    if (this.runs.get(session)?.alive) return { kind: 'already-running', status: this.status(session) };
    const found = lookup();
    if (found.kind === 'refused') return found;
    this.begin(session, mode, startedBy, found.target);
    return { kind: 'started', status: this.status(session) };
  }

  cancel(session: string): LoginCancelResult {
    const run = this.runs.get(session);
    if (!run?.alive) return { kind: 'not-running' };
    if (run.state === 'running') this.stopRun(session, run, 'canceled');
    return { kind: 'canceled', status: this.status(session) };
  }

  /** Shutdown: ends every running login and waits for them. */
  async stopAll(): Promise<void> {
    for (const [session, run] of this.runs) if (run.alive && run.state === 'running') this.stopRun(session, run, 'canceled');
    await Promise.all([...this.runs.values()].map((r) => r.exited));
  }

  private begin(session: string, mode: LoginMode, startedBy: LoginStarter, target: LoginTarget): void {
    const now = this.now();
    const tag = `aws:${session}`;
    let markExited: () => void = () => {};
    const run: Run = {
      state: 'running',
      mode,
      startedAt: new Date(now).toISOString(),
      startedMs: now,
      endedAt: null,
      exitCode: null,
      startedBy,
      timeoutSeconds: target.timeoutSeconds ?? LOGIN_TIMEOUT_SECONDS,
      child: null,
      alive: true,
      exited: new Promise<void>((r) => (markExited = r)),
      timer: null,
      deviceCode: null,
    };
    this.runs.set(session, run);
    this.o.log?.(`aws login (${session}): started by ${startedBy === 'ui' ? 'the /ui' : 'a local client'} (${mode})`);
    const now$ = () => this.now();
    const fd = openRunLog(this.logFile, runLogLine(now$, tag, `login ${mode} (${startedBy})`), {
      maxBytes: this.o.maxLogBytes,
      onError: (code) => this.o.log?.(`aws login (${session}): could not open ${this.logFile} (${code}); the output is discarded`),
    });
    // Device-code mode keeps its copy of the descriptor to write stdout into; browser mode keeps none.
    let ownFd: number | null = mode === 'device-code' ? fd : null;

    const finish = (state: LoginState, exitCode: number | null) => {
      if (!run.alive) return;
      run.alive = false;
      if (run.timer) clearTimeout(run.timer);
      if (run.state === 'running') {
        run.state = state;
        run.endedAt = new Date(this.now()).toISOString();
      }
      run.exitCode = exitCode;
      run.deviceCode = null;
      closeQuietly(ownFd);
      ownFd = null;
      const seconds = Math.round((this.now() - run.startedMs) / 1000);
      this.o.log?.(`aws login (${session}): ${run.state}${exitCode === null ? '' : ` (exit ${exitCode})`} after ${seconds} s`);
      if (fd !== null) {
        appendRunLogLine(this.logFile, runLogLine(now$, tag, `end ${run.state} exit ${exitCode === null ? 'none' : exitCode} after ${seconds} s`), (code) =>
          this.o.log?.(`aws login (${session}): could not write ${this.logFile} (${code})`),
        );
      }
      markExited();
      this.o.onChange?.(session);
      if (run.state === 'succeeded') this.o.onSucceeded?.(session);
    };

    const [command, ...args] = target.argv;
    let child: ChildProcess;
    try {
      child = (this.o.spawn ?? (nodeSpawn as Spawn))(command!, args, {
        shell: false,
        detached: true,
        stdio: mode === 'device-code' ? ['ignore', 'pipe', fd === null ? 'ignore' : fd] : fd === null ? 'ignore' : ['ignore', fd, fd],
        cwd: this.o.cwd ?? homedir(),
        env: this.o.env ?? reconnectEnv(),
        windowsHide: true,
      });
    } catch (err) {
      if (mode !== 'device-code') closeQuietly(fd);
      this.o.log?.(`aws login (${session}): could not start (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
      finish('failed', null);
      return;
    }
    if (mode !== 'device-code') closeQuietly(fd);
    this.o.onSpawn?.(session, target.argv);
    run.child = child;
    child.unref();
    child.once('error', (err: NodeJS.ErrnoException) => {
      this.o.log?.(`aws login (${session}): could not start (${err.code ?? 'error'})`);
      finish('failed', null);
    });
    if (mode === 'device-code' && child.stdout) {
      let scanned = '';
      child.stdout.on('data', (chunk: Buffer) => {
        if (ownFd !== null) {
          try {
            writeSync(ownFd, chunk);
          } catch {
            // the log is gone; the output is discarded
          }
        }
        if (run.deviceCode || scanned.length >= MAX_SCAN_CHARS || run.state !== 'running') return;
        scanned += chunk.toString('utf8').slice(0, MAX_SCAN_CHARS - scanned.length);
        const found = extractDeviceCode(scanned);
        if (found.verificationUri && found.userCode) {
          const expires = Math.min(this.now() + DEVICE_CODE_TTL_MS, run.startedMs + run.timeoutSeconds * 1000);
          run.deviceCode = { verificationUri: found.verificationUri, userCode: found.userCode, expiresAt: new Date(expires).toISOString() };
          scanned = '';
          this.o.onChange?.(session);
        }
      });
      // `close`: the exit code AND every byte of stdout written to the log.
      child.once('close', (code) => finish(code === 0 ? 'succeeded' : 'failed', code));
    } else {
      child.once('exit', (code) => finish(code === 0 ? 'succeeded' : 'failed', code));
    }
    run.timer = setTimeout(() => {
      if (run.alive && run.state === 'running') this.stopRun(session, run, 'timed-out');
    }, run.timeoutSeconds * (this.o.msPerSecond ?? 1000));
    run.timer.unref?.();
    this.o.onChange?.(session);
  }

  private stopRun(session: string, run: Run, state: 'timed-out' | 'canceled'): void {
    run.state = state;
    run.endedAt = new Date(this.now()).toISOString();
    run.deviceCode = null;
    if (run.timer) clearTimeout(run.timer);
    run.timer = null;
    this.o.log?.(`aws login (${session}): ${state === 'canceled' ? 'canceled' : 'past the timeout'}; ending the process group`);
    const pid = run.child?.pid;
    if (pid) {
      signalGroup(pid, 'SIGTERM', run.child!);
      const kill = setTimeout(() => signalGroup(pid, 'SIGKILL', run.alive ? run.child! : null), this.o.killGraceMs ?? RECONNECT_KILL_GRACE_MS);
      kill.unref?.();
    }
    this.o.onChange?.(session);
  }
}
