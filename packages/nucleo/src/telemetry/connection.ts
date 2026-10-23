// The connection of a remote machine (#278, decision 0013 section 4): Subir (start), Parar (stop),
// Reconectar (stop if configured, then start) and "Entrar na AWS e subir o túnel" (the AWS
// connector's browser login for the linked profile's session, then, only if it exits 0, the start),
// each as ONE job of steps that the screen follows and Cancel ends. The state comes from what the
// núcleo already reads; no new command probes anything.
//
// What this module guarantees:
//
// - Only the commands of machines.json run (`connection.start`, `connection.stop`, or a lone
//   `reconnect` read as `start`), from the freshest reading of the file; plus the AWS connector's
//   fixed login template for the session that the linked profile names in THIS Mac's ~/.aws/config.
//   Nothing from the request reaches a process: the routes pass only the machine id.
// - The start step runs on the SAME runner as the old Reconnect (src/telemetry/reconnect.ts), so the
//   old route and this one never run two starts at once; the stop step on a second runner with the
//   same mechanics and the same reconnect.log. One job per machine at a time.
// - The state (`deriveConnection`, pure): `starting` / `stopping` while a job runs; `stopped` after a
//   stop the user asked for that exited 0 (until a start through the console); `up` while the remote
//   núcleo answers through the port; `failing` when the last start failed and it still does not;
//   `down` otherwise.
// - The reason (`lastError`), a CLOSED list in this order: the linked session expired
//   (`sso-expired`); the port held by another process on this Mac (`port-busy`, with its process name
//   from the existing probe); the port open and no núcleo answering (`core-not-answering`); after a
//   failed start, the known patterns searched ONLY in the bytes of reconnect.log that run wrote (from
//   the offset where its header starts, read once after the process exits, never while it runs):
//   `LOG_PATTERNS`; nothing matched: `exit-code`. Only the code reaches the API; the log text is never
//   returned, kept or logged.
// - `stopped` (and a stop job running) suppresses the machine-unreachable alert and its notification
//   (`suppressUnreachable`, read by remote.ts).
// - Every change calls `onChange(id)`, published as `{ type: 'alert', key: '<id>:connection' }`.

import { open } from 'node:fs/promises';
import type { ChangeCursor } from '../changes/cursor.ts';
import type { ConnectionConfig } from './machines-config.ts';
import type {
  CloudLinkState,
  ConnectionCloud,
  ConnectionError,
  ConnectionJob,
  ConnectionJobKind,
  ConnectionReason,
  ConnectionState,
  ConnectionStatus,
  ConnectionStep,
  ReconnectStarter,
  ReconnectStatus,
  TelemetryReading,
  TunnelPort,
} from './model.ts';
import { INVALID_MACHINES_FILE, ReconnectRunner, type CancelResult, type ReconnectControl, type ReconnectRunnerOptions, type StartResult } from './reconnect.ts';
import type { MachineStatus } from './service.ts';

/** The closed list of patterns of a failed start's log bytes, in order (decision 0013 section 4). */
export const LOG_PATTERNS: readonly (readonly [RegExp, ConnectionReason])[] = [
  [/TargetNotConnected/, 'ssm-agent-offline'],
  [/Could not resolve hostname/, 'host-unknown'],
  [/Permission denied \(publickey/, 'key-refused'],
  [/Address already in use/, 'port-busy'],
  [/Token has expired|Error loading SSO Token/, 'sso-expired'],
];
/** At most this much of a run's log bytes is searched (its last part, when it wrote more). */
export const MAX_REASON_BYTES = 2 * 1024 * 1024;

/**
 * The reason of a failed run, from the bytes of `logFile` from `offset` to the end. A file shorter than
 * the offset was rotated when the run opened it: its bytes start at 0 of the new file. `exit-code` when
 * nothing matches or the file cannot be read. The text never leaves this function.
 */
export async function reasonFromLog(logFile: string, offset: number | null, maxBytes = MAX_REASON_BYTES): Promise<ConnectionReason> {
  if (offset === null) return 'exit-code';
  let fh: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fh = await open(logFile, 'r');
    const size = (await fh.stat()).size;
    let start = size < offset ? 0 : offset;
    if (size - start > maxBytes) start = size - maxBytes;
    const length = size - start;
    if (length <= 0) return 'exit-code';
    const buf = Buffer.alloc(length);
    await fh.read(buf, 0, length, start);
    const text = buf.toString('utf8');
    for (const [pattern, reason] of LOG_PATTERNS) if (pattern.test(text)) return reason;
    return 'exit-code';
  } catch {
    return 'exit-code';
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------------
// Deriving the state (pure)

/** The tunnel of this Mac that forwards `port`, and whether another process holds the port. */
export function tunnelFor(reading: TelemetryReading | null, port: number): { ports: TunnelPort[]; since: string | null; busy: boolean; holder: string | null } {
  const tunnel = reading?.tunnels?.find((t) => t.ports.some((p) => p.localPort === port)) ?? null;
  const ports = tunnel ? tunnel.ports.map((p) => ({ ...p })) : [];
  const own = tunnel?.ports.find((p) => p.localPort === port) ?? null;
  if (own?.state === 'busy') return { ports, since: tunnel!.since, busy: true, holder: own.heldBy };
  if (!tunnel) {
    // No ssh forwards the port, but something here listens on it: the same rule as the tunnel probe (darwin.ts).
    const listener = reading?.ports?.find((p) => p.port === port && p.process !== 'ssh') ?? null;
    if (listener) return { ports, since: null, busy: true, holder: listener.process };
  }
  return { ports, since: tunnel?.since ?? null, busy: false, holder: null };
}

export interface Failure {
  reason: ConnectionReason;
  at: string;
  exitCode: number | null;
}

export interface CloudLookup {
  cloud: ConnectionCloud;
  /** The connector can run the login for the session (found, a supported name, CLI v2, a good file). */
  loginPossible: boolean;
}

export interface DeriveInput {
  config: ConnectionConfig | null;
  port: number;
  machine: MachineStatus | null;
  job: ConnectionJob | null;
  /** The job's processes are still alive (a canceled one may still be dying). */
  jobAlive: boolean;
  stoppedAt: string | null;
  failure: Failure | null;
  reading: TelemetryReading | null;
  cloud: CloudLookup | null;
  logFile: string | null;
  now: number;
  /** The state and since of the previous derivation. */
  memo: { state: ConnectionState; since: string | null } | null;
}

const RELOGIN_STATES: readonly CloudLinkState[] = ['expired', 'expiring', 'never', 'unknown'];

export function deriveConnection(i: DeriveInput): { status: ConnectionStatus; memo: { state: ConnectionState; since: string | null } } {
  const nowIso = new Date(i.now).toISOString();
  const running = i.jobAlive && i.job?.state === 'running';
  const tunnel = tunnelFor(i.reading, i.port);
  const reachable = i.machine?.state === 'connected' || i.machine?.state === 'incompatible-version';
  let state: ConnectionState;
  if (running) state = i.job!.kind === 'stop' ? 'stopping' : 'starting';
  else if (i.stoppedAt) state = 'stopped';
  else if (reachable) state = 'up';
  else if (i.failure) state = 'failing';
  else state = 'down';

  let since: string | null;
  if (i.memo && i.memo.state === state) since = i.memo.since;
  else if (state === 'up') since = tunnel.since ?? nowIso;
  else if (state === 'stopped') since = i.stoppedAt;
  else if (state === 'starting' || state === 'stopping') since = i.job!.startedAt;
  else if (state === 'failing') since = i.failure!.at;
  else since = nowIso;

  let lastError: ConnectionError | null = null;
  if (state === 'down' || state === 'failing') {
    const at = since ?? nowIso;
    if (i.cloud?.cloud.state === 'expired') lastError = { reason: 'sso-expired', at, exitCode: null, holder: null };
    else if (tunnel.busy) lastError = { reason: 'port-busy', at, exitCode: null, holder: tunnel.holder };
    else if (i.machine?.state === 'unreachable' && i.machine.reason === 'no-response') lastError = { reason: 'core-not-answering', at, exitCode: null, holder: null };
    else if (i.failure) lastError = { reason: i.failure.reason, at: i.failure.at, exitCode: i.failure.exitCode, holder: i.failure.reason === 'port-busy' ? tunnel.holder : null };
  }

  const configured = i.config !== null;
  const idle = configured && !i.jobAlive;
  const actions = {
    start: idle && state !== 'up',
    stop: idle && !!i.config?.stop && state === 'up',
    reconnect: idle && state !== 'stopped',
    loginAndStart: idle && state !== 'up' && !!i.cloud?.loginPossible && RELOGIN_STATES.includes(i.cloud.cloud.state),
  };
  const status: ConnectionStatus = {
    configured,
    state,
    since,
    ports: tunnel.ports,
    cloud: i.cloud ? { ...i.cloud.cloud } : null,
    lastError,
    actions,
    command: i.config
      ? {
          start: [...i.config.start.command],
          stop: i.config.stop ? [...i.config.stop.command] : null,
          startTimeoutSeconds: i.config.start.timeoutSeconds,
          stopTimeoutSeconds: i.config.stop?.timeoutSeconds ?? null,
        }
      : null,
    job: i.job ? { ...i.job, steps: [...i.job.steps] } : null,
    logFile: configured ? i.logFile : null,
  };
  return { status, memo: { state, since } };
}

// ---------------------------------------------------------------------------------------------
// The jobs

export interface ConnectionMachine {
  readonly port: number;
  status(): MachineStatus;
  readNow(): Promise<unknown>;
}

/** What the connection needs of the machines (RemoteMachines in production). */
export interface ConnectionRegistry {
  refresh(): Promise<void>;
  fileInvalid(): boolean;
  connectionOf(id: string): ConnectionConfig | null | undefined;
  get(id: string): ConnectionMachine | undefined;
}

/** A login's state as the AWS connector reports it (src/clouds/aws-login.ts `LoginStatus`). */
export interface CloudLoginStatus {
  state: 'idle' | 'running' | 'succeeded' | 'failed' | 'timed-out' | 'canceled';
  timeoutSeconds: number;
}

/** What the connection needs of the AWS connector (src/clouds/aws-connector.ts `AwsConnector`). */
export interface CloudLogins {
  view(): Promise<{
    cli: { found: boolean; version: number | null };
    configFile: { status: 'ok' | 'missing' | 'error' };
    sessions: { name: string; loginSupported: boolean; state: 'valid' | 'expiring' | 'expired' | 'never' | 'unknown'; expiresAt: string | null; profiles: { name: string }[] }[];
  }>;
  login(name: string, mode: 'browser', startedBy: ReconnectStarter): Promise<{ kind: 'started' | 'already-running' } | { kind: 'refused'; reason: string }>;
  cancel(name: string): Promise<{ kind: string }>;
  logins: { exited(name: string): Promise<void>; status(name: string): CloudLoginStatus };
}

export type ConnectionRefusal =
  | 'unknown'
  | 'not-configured'
  | 'invalid-file'
  | 'busy'
  | 'no-stop-command'
  | 'no-cloud-profile'
  | 'cloud-unavailable'
  | 'profile-not-found'
  | 'login-not-possible'
  | 'invalid-aws-config'
  | 'cli-missing'
  | 'cli-unsupported'
  | 'name-not-supported'
  | 'not-running';

export type ConnectionResult = { kind: 'started' | 'already-running' | 'canceled'; status: ConnectionStatus } | { kind: 'refused'; reason: ConnectionRefusal };

export interface MachineConnectionOptions {
  registry: ConnectionRegistry;
  /** The start runner, shared with the old Reconnect route (its lookup gives `connection.start`). */
  startRunner: ReconnectRunner;
  logFile: string;
  cloud?: CloudLogins | null;
  /** This Mac's newest reading (its tunnels and listening ports). */
  localReading?: () => Promise<TelemetryReading | null>;
  onChange?: (machineId: string) => void;
  now?: () => number;
  /** The stop runner's knobs (tests: msPerSecond, killGraceMs). */
  runner?: Partial<Omit<ReconnectRunnerOptions, 'logFile' | 'lookup' | 'onChange' | 'onSucceeded'>>;
  log?: (message: string) => void;
}

type StepOutcome = 'ok' | 'failed' | 'timed-out' | 'canceled';

interface Job {
  view: ConnectionJob;
  alive: boolean;
  cancel: boolean;
  session: string | null;
  started: Promise<void>;
  markStarted: () => void;
  /** Resolves when the job has ended and its processes have exited. */
  done: Promise<void>;
}

interface Entry {
  job: Job | null;
  stoppedAt: string | null;
  failure: Failure | null;
  memo: { state: ConnectionState; since: string | null } | null;
}

const STEPS: Record<ConnectionJobKind, ConnectionStep[]> = {
  start: ['start', 'read'],
  stop: ['stop', 'read'],
  reconnect: ['stop', 'start', 'read'],
  'login-and-start': ['login', 'start', 'read'],
};

const AWS_REFUSALS: Record<string, ConnectionRefusal> = {
  unknown: 'profile-not-found',
  'invalid-file': 'invalid-aws-config',
  'cli-missing': 'cli-missing',
  'cli-unsupported': 'cli-unsupported',
  'name-not-supported': 'name-not-supported',
};

export class MachineConnection {
  readonly stopRunner: ReconnectRunner;
  private readonly o: MachineConnectionOptions;
  private readonly entries = new Map<string, Entry>();
  private readonly claiming = new Set<string>();

  constructor(options: MachineConnectionOptions) {
    this.o = options;
    this.stopRunner = new ReconnectRunner({
      log: options.log,
      ...options.runner,
      logFile: options.logFile,
      lookup: async (id) => {
        const c = await this.lookup(id);
        return c === undefined || c === INVALID_MACHINES_FILE ? c : (c?.stop ?? null);
      },
    });
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  private entry(id: string): Entry {
    let e = this.entries.get(id);
    if (!e) this.entries.set(id, (e = { job: null, stoppedAt: null, failure: null, memo: null }));
    return e;
  }

  private changed(id: string): void {
    this.o.onChange?.(id);
  }

  /** The freshest connection of the machine: `undefined` unknown, `null` none, `INVALID_MACHINES_FILE` while the file is invalid. */
  private async lookup(id: string): Promise<ConnectionConfig | null | undefined | typeof INVALID_MACHINES_FILE> {
    await this.o.registry.refresh();
    const c = this.o.registry.connectionOf(id);
    return c !== undefined && this.o.registry.fileInvalid() ? INVALID_MACHINES_FILE : c;
  }

  /** Stopped by the user, or a stop running: the drop does not raise machine-unreachable (remote.ts). */
  suppressUnreachable(id: string): boolean {
    const e = this.entries.get(id);
    if (!e) return false;
    return e.stoppedAt !== null || (e.job?.alive === true && e.job.view.kind === 'stop');
  }

  private async cloudOf(config: ConnectionConfig | null): Promise<CloudLookup | null> {
    const link = config?.cloudProfile;
    if (!link) return null;
    const base = { connector: link.connector, profile: link.profile } as const;
    if (!this.o.cloud) return { cloud: { ...base, session: null, state: 'unavailable', expiresAt: null }, loginPossible: false };
    const view = await this.o.cloud.view().catch(() => null);
    if (!view) return { cloud: { ...base, session: null, state: 'unknown', expiresAt: null }, loginPossible: false };
    const s = view.sessions.find((x) => x.profiles.some((p) => p.name === link.profile));
    if (!s) return { cloud: { ...base, session: null, state: 'not-found', expiresAt: null }, loginPossible: false };
    return {
      cloud: { ...base, session: s.name, state: s.state, expiresAt: s.expiresAt },
      loginPossible: s.loginSupported && view.cli.found && view.cli.version === 2 && view.configFile.status !== 'error',
    };
  }

  /** The machine's connection for `GET /api/machines`; `null` for an id that is not a remote machine. */
  async status(id: string): Promise<ConnectionStatus | null> {
    const config = this.o.registry.connectionOf(id);
    const machine = this.o.registry.get(id);
    if (config === undefined || !machine) return null;
    const e = this.entry(id);
    const [cloud, reading] = await Promise.all([this.cloudOf(config), this.o.localReading?.().catch(() => null) ?? Promise.resolve(null)]);
    const { status, memo } = deriveConnection({
      config,
      port: machine.port,
      machine: machine.status(),
      job: e.job?.view ?? null,
      jobAlive: e.job?.alive === true,
      stoppedAt: e.stoppedAt,
      failure: e.failure,
      reading,
      cloud,
      logFile: this.o.logFile,
      now: this.now(),
      memo: e.memo,
    });
    e.memo = memo;
    // Up again: the last failure no longer explains anything.
    if (status.state === 'up') e.failure = null;
    return status;
  }

  start(id: string, by: ReconnectStarter): Promise<ConnectionResult> {
    return this.begin(id, 'start', by);
  }

  stop(id: string, by: ReconnectStarter): Promise<ConnectionResult> {
    return this.begin(id, 'stop', by);
  }

  reconnect(id: string, by: ReconnectStarter): Promise<ConnectionResult> {
    return this.begin(id, 'reconnect', by);
  }

  loginAndStart(id: string, by: ReconnectStarter): Promise<ConnectionResult> {
    return this.begin(id, 'login-and-start', by);
  }

  /** Cancelar: ends the step that runs (its process group, or the login); the job is `canceled` at once. */
  async cancel(id: string): Promise<ConnectionResult> {
    const e = this.entries.get(id);
    const job = e?.job;
    if (!job?.alive) {
      if (this.o.registry.connectionOf(id) === undefined) {
        await this.o.registry.refresh();
        if (this.o.registry.connectionOf(id) === undefined) return { kind: 'refused', reason: 'unknown' };
      }
      return { kind: 'refused', reason: 'not-running' };
    }
    await job.started;
    if (job.view.state === 'running') {
      job.cancel = true;
      job.view.state = 'canceled';
      job.view.endedAt = new Date(this.now()).toISOString();
      const step = job.view.step;
      if (step === 'login' && job.session && this.o.cloud) await this.o.cloud.cancel(job.session).catch(() => null);
      if (step === 'start') await this.o.startRunner.cancel(id).catch(() => null);
      if (step === 'stop') await this.stopRunner.cancel(id).catch(() => null);
      this.o.log?.(`connection (${id}): ${job.view.kind} canceled at ${step}`);
      this.changed(id);
    }
    return { kind: 'canceled', status: (await this.status(id))! };
  }

  private async begin(id: string, kind: ConnectionJobKind, by: ReconnectStarter): Promise<ConnectionResult> {
    const e = this.entry(id);
    if (this.claiming.has(id) || e.job?.alive) {
      if (e.job?.alive && e.job.view.kind === kind && e.job.view.state === 'running') {
        await e.job.started;
        return { kind: 'already-running', status: (await this.status(id))! };
      }
      return { kind: 'refused', reason: 'busy' };
    }
    this.claiming.add(id);
    try {
      const config = await this.lookup(id);
      if (config === undefined || !this.o.registry.get(id)) return { kind: 'refused', reason: 'unknown' };
      if (config === INVALID_MACHINES_FILE) return { kind: 'refused', reason: 'invalid-file' };
      if (config === null) return { kind: 'refused', reason: 'not-configured' };
      // A start run outside a job (none should exist, but the runner is shared): never two at once.
      if (this.o.startRunner.alive(id) || this.stopRunner.alive(id)) return { kind: 'refused', reason: 'busy' };
      if (kind === 'stop' && !config.stop) return { kind: 'refused', reason: 'no-stop-command' };
      let session: string | null = null;
      if (kind === 'login-and-start') {
        if (!config.cloudProfile) return { kind: 'refused', reason: 'no-cloud-profile' };
        const found = await this.cloudOf(config);
        if (!this.o.cloud || !found || found.cloud.state === 'unavailable') return { kind: 'refused', reason: 'cloud-unavailable' };
        if (!found.cloud.session) return { kind: 'refused', reason: 'profile-not-found' };
        if (!found.loginPossible) return { kind: 'refused', reason: 'login-not-possible' };
        session = found.cloud.session;
        const r = await this.o.cloud.login(session, 'browser', by);
        if (r.kind === 'refused') return { kind: 'refused', reason: AWS_REFUSALS[r.reason] ?? 'login-not-possible' };
      }
      const now = new Date(this.now()).toISOString();
      let markStarted: () => void = () => {};
      const job: Job = {
        view: {
          kind,
          steps: [...STEPS[kind]],
          step: STEPS[kind][0]!,
          state: 'running',
          startedAt: now,
          endedAt: null,
          stepStartedAt: now,
          stepTimeoutSeconds: null,
          startedBy: by,
        },
        alive: true,
        cancel: false,
        session,
        started: new Promise<void>((r) => (markStarted = r)),
        markStarted: () => markStarted(),
        done: Promise.resolve(),
      };
      // Any start through the console ends "stopped by you"; a new job forgets the last failure.
      if (kind !== 'stop') e.stoppedAt = null;
      e.failure = null;
      e.job = job;
      this.o.log?.(`connection (${id}): ${kind} started by ${by === 'ui' ? 'the /ui' : 'a local client'}`);
      job.done = this.run(id, job, config);
      await job.started;
      return { kind: 'started', status: (await this.status(id))! };
    } finally {
      this.claiming.delete(id);
    }
  }

  private async run(id: string, job: Job, config: ConnectionConfig): Promise<void> {
    const e = this.entry(id);
    let outcome: StepOutcome = 'ok';
    try {
      for (const step of job.view.steps) {
        if (job.cancel) {
          outcome = 'canceled';
          break;
        }
        this.enterStep(id, job, step, config);
        outcome = await this.runStep(id, job, step);
        if (job.cancel) outcome = 'canceled';
        if (outcome === 'canceled') break;
        if (outcome !== 'ok') {
          // Reconnect: a stop that fails (nothing to stop, say) still lets the start run.
          if (step === 'stop' && job.view.kind === 'reconnect') continue;
          break;
        }
        if (step === 'stop' && job.view.kind === 'stop') e.stoppedAt = new Date(this.now()).toISOString();
      }
    } catch (err) {
      this.o.log?.(`connection (${id}): ${(err as Error).message}`);
      outcome = 'failed';
    } finally {
      job.markStarted();
      if (job.view.state === 'running') {
        job.view.state = outcome === 'ok' ? 'succeeded' : outcome;
        job.view.endedAt = new Date(this.now()).toISOString();
      }
      job.alive = false;
      this.o.log?.(`connection (${id}): ${job.view.kind} ${job.view.state} at ${job.view.step}`);
      this.changed(id);
    }
  }

  private enterStep(id: string, job: Job, step: ConnectionStep, config: ConnectionConfig): void {
    job.view.step = step;
    job.view.stepStartedAt = new Date(this.now()).toISOString();
    job.view.stepTimeoutSeconds =
      step === 'start' ? config.start.timeoutSeconds : step === 'stop' ? (config.stop?.timeoutSeconds ?? null) : step === 'login' && job.session ? (this.o.cloud?.logins.status(job.session).timeoutSeconds ?? null) : null;
    this.changed(id);
  }

  private async runStep(id: string, job: Job, step: ConnectionStep): Promise<StepOutcome> {
    const by = job.view.startedBy;
    if (step === 'login') {
      // Started in `begin` (so a refusal is the route's answer); here, its end.
      job.markStarted();
      const session = job.session!;
      await this.o.cloud!.logins.exited(session);
      const s = this.o.cloud!.logins.status(session).state;
      return s === 'succeeded' ? 'ok' : s === 'canceled' ? 'canceled' : s === 'timed-out' ? 'timed-out' : 'failed';
    }
    if (step === 'read') {
      job.markStarted();
      await this.o.registry.get(id)?.readNow().catch(() => null);
      return 'ok';
    }
    const runner = step === 'start' ? this.o.startRunner : this.stopRunner;
    const r = await runner.start(id, by);
    job.markStarted();
    if (r.kind === 'unknown' || r.kind === 'not-configured' || r.kind === 'invalid-file') return 'failed';
    await runner.exited(id);
    const out = runner.lastRun(id);
    if (!out || out.state === 'canceled') return 'canceled';
    if (out.state === 'succeeded') return 'ok';
    if (step === 'start') {
      // Read only now that the process has exited, and only this run's bytes.
      const reason = await reasonFromLog(out.logFile, out.logOffset);
      this.entry(id).failure = { reason, at: out.endedAt ?? new Date(this.now()).toISOString(), exitCode: out.exitCode };
    }
    return out.state === 'timed-out' ? 'timed-out' : 'failed';
  }

  /** The old `POST`/`DELETE /api/machines/<id>/reconnect` (decision 0012), now a start job of this connection. */
  readonly legacy: ReconnectControl = {
    start: async (id: string, by: ReconnectStarter): Promise<StartResult> => {
      const r = await this.start(id, by);
      if (r.kind === 'refused') {
        if (r.reason === 'unknown') return { kind: 'unknown' };
        if (r.reason === 'not-configured') return { kind: 'not-configured' };
        if (r.reason === 'invalid-file') return { kind: 'invalid-file' };
        return { kind: 'already-running', status: this.startStatus(id) };
      }
      return { kind: r.kind === 'started' ? 'started' : 'already-running', status: this.startStatus(id) };
    },
    cancel: async (id: string): Promise<CancelResult> => {
      const r = await this.cancel(id);
      if (r.kind === 'refused') return r.reason === 'unknown' ? { kind: 'unknown' } : { kind: 'not-running' };
      return { kind: 'canceled', status: this.startStatus(id) };
    },
  };

  private startStatus(id: string): ReconnectStatus {
    return this.o.startRunner.status(id, this.o.registry.connectionOf(id)?.start ?? null);
  }

  /** Resolves when the machine's job (if any) has ended. */
  async settled(id: string): Promise<void> {
    await this.entries.get(id)?.job?.done;
  }

  /** Shutdown: cancels every job and waits for its processes. */
  async stopAll(): Promise<void> {
    for (const [id, e] of this.entries) if (e.job?.alive) await this.cancel(id).catch(() => null);
    await Promise.all([...this.entries.keys()].map(async (id) => {
      await this.stopRunner.exited(id);
      await this.o.startRunner.exited(id);
    }));
  }
}

/** Each connection change as an `alert` change keyed `<machine>:connection` (decision 0013 section 6). */
export function publishConnectionChanges(cursor: ChangeCursor): (machineId: string) => void {
  return (machineId) => {
    cursor.record({ type: 'alert', key: `${machineId}:connection`, sessionId: null, accountId: null });
  };
}
