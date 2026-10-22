// The Tools executor (#280, decision 0014 sections 3 and 4): runs the catalog's actions as jobs, one
// at a time per machine, and keeps them for the screen. What this module guarantees:
//
// - Nothing from the request reaches a process. A POST names a tool, an action and the `planDigest`
//   the screen showed; the plan is rebuilt here from the núcleo's own detection and catalog
//   (`ToolsService.actionPlan`). Another digest: 409 with the new plan, nothing runs. A plan that is
//   not runnable (admin, invalid version, offline, no manager): refused, nothing runs.
// - One job at a time per machine, FIFO (Atualizar N enqueues N). The same tool and action already
//   queued or running gets that job back. `jobs.batch` (`{ total, done }`) opens with the first job
//   enqueued on an idle queue and closes when the queue drains: the screen's "Atualizando 2 de 5".
// - Each step: `spawn(argv[0], argv.slice(1), { shell: false, detached: true })` with argv[0]
//   resolved on the login PATH, standard input closed, stdout and stderr piped, the user's home as
//   the working directory and `toolsEnv` (runner.ts). Step 2 runs only if step 1 exits 0.
// - A plan marked `admin` is refused by `act` (`blocked`, nothing queued, whatever its argv[0]). And
//   before the first spawn, a job any of whose steps has an argv[0] (or its realpath) named sudo,
//   doas, pkexec, su, runas or osascript fails with nothing spawned, even if the catalog forgot the mark.
// - Timeout per step (the plan's, 600 s by default, 1800 at most) and Cancel: SIGTERM to the process
//   group, SIGKILL to the group 5 s later; the state changes at once (`timed-out`, `canceled`).
// - After the last step exits 0: phase `verifying`, the tool is probed again and the new installed
//   version is recorded (`ToolsService.verify`), then `succeeded`.
// - Output: read by line and MASKED before it goes anywhere (`maskSecrets`): the last 200 lines stay
//   on the job (the API), the whole masked output goes to `tools.log` in the installation's data
//   folder (append, 0600, rotated to `tools.log.1` when past 1 MB at a job's start), between a header
//   and a footer line per job, like reconnect.log.
// - Every state change calls `onChange(machine)`: a `tools` change keyed by the machine on
//   /api/changes (`publishToolsChanges`; HTTP only, filtered out of MCP).
// - Verificar agora (`checkNow`): `ToolsService.check`, one at a time and serialized with the queue:
//   it waits for the running job to end, and no job starts while it runs (`brew update` would rewrite
//   the formula cache under a `brew upgrade`, and a check that began before a job's verify would write
//   the old `installed` back). It waits a little for the answer, then answers with the current body and
//   a `tools` change follows when it ends.
// - `stopAll` (the núcleo's shutdown): the queue is canceled, the running group gets SIGTERM and, after
//   the grace period, SIGKILL; the `end canceled` footer reaches tools.log. No step outlives the núcleo.
// - No scheduled re-check: the network is read only on Verificar agora (layer 1 left it out; layer 2
//   keeps it so). After 6 h the states go back to `checking`.

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, fchmodSync, mkdirSync, openSync, renameSync, statSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ChangeCursor } from '../changes/cursor.ts';
import { isAdminExecutable, type ActionId } from './catalog.ts';
import type { ActionPlanResult, JobsView, ToolActionView, ToolsOverview } from './service.ts';

export const TOOLS_LOG_FILE = 'tools.log';
export const MAX_TOOLS_LOG_BYTES = 1024 * 1024;
export const TOOLS_KILL_GRACE_MS = 5_000;
export const JOB_OUTPUT_LINES = 200;
export const RECENT_JOBS = 10;
/** How long `POST /api/tools/checks` waits for the check before answering 202. */
export const CHECK_WAIT_MS = 20_000;
const MAX_LINE_CHARS = 4_000;
/** After the process exits, how long its pipes may stay open (a daemon that kept them) before they are dropped. */
const PIPE_DRAIN_MS = 1_000;
export const JOB_ID = /^[a-f0-9]{12}$/;

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'timed-out' | 'canceled';

/** A job as the API shows it (contract, UI request 1). */
export interface ToolJob {
  id: string;
  toolId: string;
  actionId: ActionId;
  /** pt-BR, for display: `Atualizar GitHub CLI`. */
  label: string;
  machine: string;
  state: JobState;
  steps: string[][];
  /** The index of the current (or last run) step. */
  step: number;
  /** Meaningful while `running`: `verifying` once the steps are done and the tool is probed again. */
  phase: 'running' | 'verifying';
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
  timeoutSeconds: number;
  targetVersion: string | null;
  /** The last 200 output lines, masked. */
  output: string[];
  logFile: string;
}

/** What the executor needs from the service (service.ts). */
export interface ToolsHost {
  overview(machine: string): Promise<ToolsOverview | null>;
  check(machine: string): Promise<ToolsOverview | null>;
  /** Verificar conexões (layer 3): `claude mcp list`; optional for a host without MCP. */
  mcpCheck?(machine: string): Promise<ToolsOverview | null>;
  actionPlan(machine: string, toolId: string, actionId: string): Promise<ActionPlanResult>;
  verify(machine: string, toolId: string): Promise<string | null>;
  invalidate(): void;
  processEnv(): Promise<NodeJS.ProcessEnv>;
  resolveExecutable(name: string): Promise<{ path: string | null; realPath: string | null }>;
}

export type ActResult =
  | { kind: 'unknown-machine' }
  | { kind: 'unknown' }
  | { kind: 'not-offered' }
  | { kind: 'stale'; plan: ToolActionView }
  | { kind: 'blocked'; plan: ToolActionView }
  | { kind: 'queued'; job: ToolJob };
export type CancelJobResult = { kind: 'unknown' } | { kind: 'ended'; job: ToolJob } | { kind: 'canceled'; job: ToolJob };
export type CheckNowResult = { kind: 'unknown-machine' } | { kind: 'done' | 'running'; body: ToolsOverview };

/** What the routes need (src/api/tools.ts). */
export interface ToolsControl {
  overview(machine: string): Promise<ToolsOverview | null>;
  act?(machine: string, toolId: string, actionId: string, planDigest: string): Promise<ActResult>;
  cancel?(jobId: string): CancelJobResult;
  checkNow?(machine: string): Promise<CheckNowResult>;
  /** Verificar conexões: `claude mcp list` (independent of the job queue: it changes nothing on disk). */
  mcpCheckNow?(machine: string): Promise<CheckNowResult>;
  /**
   * Layer 4's hook: a loopback write with NO `Origin` (the tunnel) is accepted only when this says so
   * (`tools.acceptRemoteActions` in config.json). Default false: no Origin, 403.
   */
  acceptNoOriginActions?(): boolean;
}

type Spawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface ToolsExecutorOptions {
  service: ToolsHost;
  logFile: string;
  onChange?: (machine: string) => void;
  spawn?: Spawn;
  /** Sends a signal to a process group (tests record it; nothing real is signaled). */
  killGroup?: (pid: number, signal: NodeJS.Signals, child: ChildProcess) => void;
  cwd?: string;
  now?: () => number;
  /** Tests shorten the time unit; 1000 in production. */
  msPerSecond?: number;
  killGraceMs?: number;
  maxLogBytes?: number;
  checkWaitMs?: number;
  acceptNoOriginActions?: () => boolean;
  log?: (message: string) => void;
}

interface Running {
  child: ChildProcess | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** Ends the current step's wait even if the process never reports its exit (after SIGKILL). */
  release: (() => void) | null;
}

interface MachineJobs {
  current: ToolJob | null;
  queue: ToolJob[];
  recent: ToolJob[];
  batch: { total: number; done: number } | null;
  idle: (() => void)[];
  /** `checkNow` waits here for the running job to end. */
  afterCurrent: (() => void)[];
}

export function toolsLogFile(dataDir: string): string {
  return join(dataDir, TOOLS_LOG_FILE);
}

const SECRET_NAME = '[A-Za-z0-9_.-]*(?:token|passw(?:or)?d|passwd|pwd|secret|key|signature|credential|auth)[A-Za-z0-9_.-]*';
const MASKS: [RegExp, string | ((...m: string[]) => string)][] = [
  // Authorization: Basic xxx / Bearer xxx / a bare value
  [/\b((?:proxy-)?authorization)(\s*[:=]\s*)(?:(basic|bearer|token|digest)\s+)?[^\s,;]+/gi, (_m, name, sep, scheme) => `${name}${sep}${scheme ? `${scheme} ` : ''}***`],
  [/\b(bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 ***'],
  // Cookie: a=b; c=d (the whole value), Set-Cookie too
  [/\b((?:set-)?cookie)(\s*[:=]\s*)[^\r\n]+/gi, '$1$2***'],
  // bare GitHub and npm tokens
  [/\b(?:gh[pousr]_|github_pat_|npm_)[A-Za-z0-9_]{20,}/g, '***'],
  // --token VALUE, -password VALUE (the value in the next word, unless that is another flag)
  [new RegExp(`(^|\\s)(--?${SECRET_NAME})(\\s+)(?!-)\\S+`, 'gi'), '$1$2$3***'],
  // scheme://user:pass@host and scheme://token@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"]+@/gi, '$1***@'],
  // token=…, password: …, --api-key=…, "secret": "…", X-Amz-Signature=…
  [new RegExp(`(${SECRET_NAME}["']?)(\\s*[=:]\\s*)(["']?)[^\\s&"',;]+`, 'gi'), '$1$2$3***'],
];

/** Masks credentials in one line of output before it leaves the process. Over-masking is fine. */
export function maskSecrets(line: string): string {
  let out = line;
  for (const [re, to] of MASKS) out = out.replace(re, to as string);
  // `Authorization: Bearer ***` read again by the last rule gives `*** ***`: one is enough.
  return out.replace(/\*\*\* \*\*\*/g, '***');
}

export class ToolsExecutor implements ToolsControl {
  readonly logFile: string;
  private readonly o: ToolsExecutorOptions;
  private readonly machines = new Map<string, MachineJobs>();
  private readonly running = new Map<string, Running>();
  private readonly checks = new Map<string, Promise<ToolsOverview | null>>();
  private readonly mcpChecks = new Map<string, Promise<ToolsOverview | null>>();
  private readonly endNotes = new Map<string, string>();
  private closing = false;

  constructor(options: ToolsExecutorOptions) {
    this.o = options;
    this.logFile = options.logFile;
  }

  acceptNoOriginActions(): boolean {
    return this.o.acceptNoOriginActions?.() ?? false;
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  private jobsOf(machine: string): MachineJobs {
    let m = this.machines.get(machine);
    if (!m) this.machines.set(machine, (m = { current: null, queue: [], recent: [], batch: null, idle: [], afterCurrent: [] }));
    return m;
  }

  /** `jobs` of `GET /api/tools`: copies, so a response never changes after it is built. */
  jobs(machine: string): JobsView<ToolJob> {
    const m = this.machines.get(machine);
    return { current: m?.current ? copyJob(m.current) : null, queue: (m?.queue ?? []).map(copyJob), recent: (m?.recent ?? []).map(copyJob), batch: m?.batch ? { ...m.batch } : null };
  }

  async overview(machine: string): Promise<ToolsOverview | null> {
    const body = await this.o.service.overview(machine);
    return body ? { ...body, jobs: this.jobs(machine) } : null;
  }

  /** Resolves when the machine has nothing running and nothing queued (tests, shutdown). */
  idle(machine: string): Promise<void> {
    const m = this.jobsOf(machine);
    if (!m.current && m.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => m.idle.push(resolve));
  }

  async act(machine: string, toolId: string, actionId: string, planDigest: string): Promise<ActResult> {
    const r = await this.o.service.actionPlan(machine, toolId, actionId);
    if (r.kind !== 'plan') return r;
    if (r.action.planDigest !== planDigest) return { kind: 'stale', plan: r.action };
    // The núcleo never runs an admin step, whatever its argv[0] (decision 0014 section 3).
    if (!r.action.runnable || r.action.admin) return { kind: 'blocked', plan: r.action };
    const m = this.jobsOf(machine);
    const same = [m.current, ...m.queue].find((j) => j && j.toolId === r.toolId && j.actionId === r.actionId && (j.state === 'queued' || j.state === 'running'));
    if (same) return { kind: 'queued', job: copyJob(same) };
    const job: ToolJob = {
      id: randomBytes(6).toString('hex'),
      toolId: r.toolId,
      actionId: r.actionId,
      label: r.label,
      machine,
      state: 'queued',
      steps: r.action.steps.map((s) => [...s]),
      step: 0,
      phase: 'running',
      startedAt: null,
      endedAt: null,
      exitCode: null,
      timeoutSeconds: r.action.timeoutSeconds,
      targetVersion: r.action.targetVersion,
      output: [],
      logFile: this.logFile,
    };
    m.queue.push(job);
    m.batch ??= { total: 0, done: 0 };
    m.batch.total++;
    this.o.log?.(`tools (${machine}): ${job.actionId} ${job.toolId} queued (job ${job.id})`);
    this.changed(machine);
    const snapshot = copyJob(job);
    this.pump(machine);
    return { kind: 'queued', job: snapshot };
  }

  cancel(jobId: string): CancelJobResult {
    for (const [machine, m] of this.machines) {
      const queued = m.queue.findIndex((j) => j.id === jobId);
      if (queued >= 0) {
        const [job] = m.queue.splice(queued, 1);
        job!.state = 'canceled';
        job!.endedAt = new Date(this.now()).toISOString();
        this.remember(m, job!);
        this.o.log?.(`tools (${machine}): job ${jobId} canceled before it started`);
        this.wakeIdle(m);
        this.changed(machine);
        return { kind: 'canceled', job: copyJob(job!) };
      }
      if (m.current?.id === jobId) {
        const job = m.current;
        if (job.state !== 'running' || job.phase !== 'running') return { kind: 'ended', job: copyJob(job) };
        this.stop(job, 'canceled');
        return { kind: 'canceled', job: copyJob(job) };
      }
      const past = m.recent.find((j) => j.id === jobId);
      if (past) return { kind: 'ended', job: copyJob(past) };
    }
    return { kind: 'unknown' };
  }

  checkNow(machine: string): Promise<CheckNowResult> {
    return this.waitForCheck(machine, this.checks, () => this.o.service.check(machine));
  }

  /** Verificar conexões: the service's `mcpCheck`, waited for like `checkNow`; a `tools` change when it ends. */
  mcpCheckNow(machine: string): Promise<CheckNowResult> {
    const service = this.o.service;
    if (!service.mcpCheck) return Promise.resolve({ kind: 'unknown-machine' });
    return this.waitForCheck(machine, this.mcpChecks, () => service.mcpCheck!(machine));
  }

  private async waitForCheck(machine: string, running: Map<string, Promise<ToolsOverview | null>>, start: () => Promise<ToolsOverview | null>): Promise<CheckNowResult> {
    let p = running.get(machine);
    if (!p) {
      // The regular check is registered at once, so no job starts meanwhile; it waits for the running one.
      // The MCP check only runs `claude mcp list`, so it goes straight away.
      p = running === this.checks ? this.afterCurrentJob(machine).then(start) : start();
      running.set(machine, p);
      void p
        .catch(() => null)
        .then((body) => {
          running.delete(machine);
          if (body) this.changed(machine);
          this.pump(machine);
        });
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const waited = await Promise.race([
      p.then((body) => ({ done: true as const, body })),
      new Promise<{ done: false }>((resolve) => {
        timer = setTimeout(() => resolve({ done: false }), this.o.checkWaitMs ?? CHECK_WAIT_MS);
      }),
    ]).finally(() => timer && clearTimeout(timer));
    if (waited.done) return waited.body ? { kind: 'done', body: { ...waited.body, jobs: this.jobs(machine) } } : { kind: 'unknown-machine' };
    const body = await this.overview(machine);
    return body ? { kind: 'running', body } : { kind: 'unknown-machine' };
  }

  private afterCurrentJob(machine: string): Promise<void> {
    const m = this.jobsOf(machine);
    if (!m.current) return Promise.resolve();
    return new Promise((resolve) => m.afterCurrent.push(resolve));
  }

  /**
   * The núcleo's shutdown: cancels what is queued, ends the running group (SIGTERM, SIGKILL after the
   * grace) and resolves when every job has ended and written its footer to tools.log. Nothing starts after.
   */
  async stopAll(): Promise<void> {
    this.closing = true;
    const waits: Promise<void>[] = [];
    for (const [machine, m] of this.machines) {
      for (const job of m.queue.splice(0)) {
        job.state = 'canceled';
        job.endedAt = new Date(this.now()).toISOString();
        this.remember(m, job);
      }
      const job = m.current;
      if (job) {
        this.endNotes.set(job.id, 'core shut down');
        if (job.state === 'running') this.stop(job, 'canceled');
      }
      this.wakeIdle(m);
      if (job) waits.push(this.idle(machine));
      this.changed(machine);
    }
    await Promise.all(waits);
  }

  private changed(machine: string): void {
    this.o.onChange?.(machine);
  }

  /** An ended job: counted in the batch, kept in `recent`. */
  private remember(m: MachineJobs, job: ToolJob): void {
    if (m.batch) m.batch.done++;
    m.recent.unshift(job);
    m.recent.length = Math.min(m.recent.length, RECENT_JOBS);
  }

  private wakeIdle(m: MachineJobs): void {
    if (m.current || m.queue.length > 0) return;
    m.batch = null;
    for (const resolve of m.idle.splice(0)) resolve();
  }

  private pump(machine: string): void {
    const m = this.jobsOf(machine);
    if (m.current) return;
    if (this.closing) return this.wakeIdle(m);
    if (this.checks.has(machine)) return;
    const job = m.queue.shift();
    if (!job) return this.wakeIdle(m);
    m.current = job;
    void this.run(job)
      .catch((err) => {
        this.o.log?.(`tools (${machine}): job ${job.id} broke (${(err as Error).message})`);
        if (job.state === 'running') this.end(job, 'failed', null);
      })
      .finally(() => {
        m.current = null;
        this.running.delete(job.id);
        this.remember(m, job);
        for (const resolve of m.afterCurrent.splice(0)) resolve();
        // The next job (its own change) or, with the queue drained, the batch closed; then this end's change.
        this.pump(machine);
        this.changed(machine);
      });
  }

  /** The end of a running job; a job already ended (canceled, timed out) keeps its state. */
  private end(job: ToolJob, state: JobState, exitCode: number | null): void {
    if (job.state !== 'running') return;
    job.state = state;
    job.endedAt = new Date(this.now()).toISOString();
    job.exitCode = exitCode;
  }

  private async run(job: ToolJob): Promise<void> {
    const startedMs = this.now();
    job.state = 'running';
    job.startedAt = new Date(startedMs).toISOString();
    this.running.set(job.id, { child: null, timer: null, release: null });
    this.o.log?.(`tools (${job.machine}): ${job.actionId} ${job.toolId} started (job ${job.id})`);
    this.changed(job.machine);
    const fd = this.openLog(job);
    const line = (text: string) => this.emit(job, fd, text);
    try {
      const resolved = await Promise.all(job.steps.map((s) => this.o.service.resolveExecutable(s[0] ?? '').catch(() => ({ path: null, realPath: null }))));
      const refused = job.steps.findIndex((s, i) => s.length === 0 || isAdminExecutable(s[0]!) || (resolved[i]!.realPath !== null && isAdminExecutable(resolved[i]!.realPath!)));
      if (refused >= 0) {
        job.step = refused;
        line(`Recusado: este passo pede administrador e o console não roda comandos com senha. Rode no Terminal: ${job.steps[refused]!.join(' ')}`);
        this.o.log?.(`tools (${job.machine}): job ${job.id} refused (admin step)`);
        return this.end(job, 'failed', null);
      }
      const env = await this.o.service.processEnv();
      for (let i = 0; i < job.steps.length; i++) {
        if (job.state !== 'running') return;
        if (i > 0) {
          job.step = i;
          this.changed(job.machine);
        }
        const argv = job.steps[i]!;
        line(`$ ${argv.join(' ')}`);
        const code = await this.step(job, resolved[i]!.path ?? argv[0]!, argv.slice(1), env, line);
        if (job.state !== 'running') return;
        if (code !== 0) return this.end(job, 'failed', code);
      }
      job.exitCode = 0;
      job.phase = 'verifying';
      this.changed(job.machine);
      if (job.actionId === 'install' || job.actionId === 'update') {
        const installed = await this.o.service.verify(job.machine, job.toolId).catch(() => null);
        line(installed ? `Versão instalada agora: ${installed}` : 'A sonda não leu a versão instalada depois da ação.');
      } else {
        this.o.service.invalidate();
      }
      this.end(job, 'succeeded', 0);
    } finally {
      const seconds = Math.round((this.now() - startedMs) / 1000);
      this.o.log?.(`tools (${job.machine}): job ${job.id} ${job.state}${job.exitCode === null ? '' : ` (exit ${job.exitCode})`} after ${seconds} s`);
      const note = this.endNotes.get(job.id);
      this.endNotes.delete(job.id);
      this.closeLog(fd, job, `end ${job.state} exit ${job.exitCode === null ? 'none' : job.exitCode} after ${seconds} s${note ? ` (${note})` : ''}`);
    }
  }

  /** One step: resolves with its exit code (`null`: it could not start, or a signal ended it). */
  private step(job: ToolJob, command: string, args: string[], env: NodeJS.ProcessEnv, line: (text: string) => void): Promise<number | null> {
    const run = this.running.get(job.id)!;
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = (this.o.spawn ?? (nodeSpawn as Spawn))(command, args, {
          shell: false,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          cwd: this.o.cwd ?? homedir(),
          env,
          windowsHide: true,
        });
      } catch (err) {
        line(`Não deu para iniciar o comando (${(err as NodeJS.ErrnoException).code ?? 'erro'}).`);
        return resolve(null);
      }
      run.child = child;
      let settled = false;
      const done = (code: number | null) => {
        if (settled) return;
        settled = true;
        if (run.timer) clearTimeout(run.timer);
        run.timer = null;
        run.child = null;
        run.release = null;
        resolve(code);
      };
      run.release = () => done(null);
      const readers = [child.stdout, child.stderr].filter((s) => s != null).map((s) => readLines(s, line));
      child.once('error', (err: NodeJS.ErrnoException) => {
        line(`Não deu para iniciar o comando (${err.code ?? 'erro'}).`);
        done(null);
      });
      child.once('exit', (code) => {
        // The pipes close after the process; a daemon it left may keep them open: wait a little, then drop them.
        const drain = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
        }, PIPE_DRAIN_MS);
        drain.unref?.();
        void Promise.all(readers).then(() => {
          clearTimeout(drain);
          done(code);
        });
      });
      run.timer = setTimeout(() => {
        if (!settled && job.state === 'running') {
          line(`Passou do tempo limite (${job.timeoutSeconds} s): o console encerrou o processo.`);
          this.stop(job, 'timed-out');
        }
      }, job.timeoutSeconds * (this.o.msPerSecond ?? 1000));
      run.timer.unref?.();
    });
  }

  /** Timeout or Cancel: the state changes now; SIGTERM to the group, SIGKILL to the group after the grace. */
  private stop(job: ToolJob, state: 'timed-out' | 'canceled'): void {
    this.end(job, state, null);
    this.o.log?.(`tools (${job.machine}): job ${job.id} ${state === 'canceled' ? 'canceled' : 'past the timeout'}; ending the process group`);
    const run = this.running.get(job.id);
    if (run?.timer) clearTimeout(run.timer);
    if (run) run.timer = null;
    const child = run?.child;
    if (child?.pid) {
      const pid = child.pid;
      this.signal(pid, 'SIGTERM', child);
      const kill = setTimeout(() => {
        this.signal(pid, 'SIGKILL', child);
        // A process that does not report its exit even now does not hold the queue.
        const release = setTimeout(() => run?.release?.(), PIPE_DRAIN_MS);
        release.unref?.();
      }, this.o.killGraceMs ?? TOOLS_KILL_GRACE_MS);
      kill.unref?.();
    }
    this.changed(job.machine);
  }

  private signal(pid: number, signal: NodeJS.Signals, child: ChildProcess): void {
    if (this.o.killGroup) return this.o.killGroup(pid, signal, child);
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // already gone
      }
    }
  }

  /** One output line: masked, kept (last 200) and appended to tools.log. */
  private emit(job: ToolJob, fd: number | null, raw: string): void {
    // Mask the whole line first and cut after: a cut inside a credential would defeat the mask.
    const masked = maskSecrets(raw);
    const text = masked.length > MAX_LINE_CHARS ? `${masked.slice(0, MAX_LINE_CHARS)}…` : masked;
    job.output.push(text);
    if (job.output.length > JOB_OUTPUT_LINES) job.output.splice(0, job.output.length - JOB_OUTPUT_LINES);
    if (fd !== null) {
      try {
        writeSync(fd, `${text}\n`);
      } catch {
        // the log is best effort; the job keeps its lines
      }
    }
  }

  /** Opens tools.log (append, 0600; rotated to `.1` first when past the limit) and writes the header line. */
  private openLog(job: ToolJob): number | null {
    try {
      mkdirSync(dirname(this.logFile), { recursive: true, mode: 0o700 });
      let size = 0;
      try {
        size = statSync(this.logFile).size;
      } catch {
        size = 0;
      }
      if (size > (this.o.maxLogBytes ?? MAX_TOOLS_LOG_BYTES)) {
        renameSync(this.logFile, `${this.logFile}.1`);
        chmodSync(`${this.logFile}.1`, 0o600);
      }
      const fd = openSync(this.logFile, 'a', 0o600);
      try {
        fchmodSync(fd, 0o600);
        writeSync(fd, this.logLine(job, `start ${job.actionId} ${job.toolId}`));
      } catch (err) {
        closeSync(fd);
        throw err;
      }
      return fd;
    } catch (err) {
      this.o.log?.(`tools (${job.machine}): could not open ${this.logFile} (${(err as NodeJS.ErrnoException).code ?? 'error'}); the job's output stays only in memory`);
      return null;
    }
  }

  private closeLog(fd: number | null, job: ToolJob, footer: string): void {
    if (fd === null) return;
    try {
      writeSync(fd, this.logLine(job, footer));
    } catch {
      // best effort
    }
    try {
      closeSync(fd);
    } catch {
      // already closed
    }
  }

  private logLine(job: ToolJob, text: string): string {
    return `${new Date(this.now()).toISOString()} ${job.machine} job ${job.id} ${text}\n`;
  }
}

function copyJob(j: ToolJob): ToolJob {
  return { ...j, steps: j.steps.map((s) => [...s]), output: [...j.output] };
}

/** Reads a stream by line (`\n`, `\r\n` or a lone `\r`), blank lines dropped; resolves when it ends. */
function readLines(stream: NodeJS.ReadableStream & { setEncoding?: (e: BufferEncoding) => unknown }, line: (text: string) => void): Promise<void> {
  return new Promise((resolve) => {
    let buf = '';
    // Past the cut with no newline yet: the line was emitted (masked, then cut); the rest of it is dropped
    // up to the next line break, never emitted as a line of its own (a secret could straddle the boundary).
    let dropping = false;
    const flush = (all: boolean) => {
      const parts = buf.split(/\r\n|\n|\r(?!$)/);
      buf = all ? '' : (parts.pop() ?? '');
      if (!all && buf.length > MAX_LINE_CHARS) {
        parts.push(buf);
        buf = '';
        dropping = true;
      }
      for (const p of parts) if (p.trim() !== '') line(p.replace(/\r$/, ''));
    };
    stream.setEncoding?.('utf8');
    stream.on('data', (chunk: string | Buffer) => {
      let text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (dropping) {
        const brk = text.search(/\r\n|\n|\r/);
        if (brk < 0) return;
        text = text.slice(brk).replace(/^(?:\r\n|\n|\r)/, '');
        dropping = false;
      }
      buf += text;
      flush(false);
    });
    const end = () => {
      flush(true);
      resolve();
    };
    stream.once('end', end);
    stream.once('close', end);
    stream.once('error', end);
  });
}

/** Each job state change as a `tools` change keyed by the machine (HTTP only; MCP filters it out). */
export function publishToolsChanges(cursor: ChangeCursor): (machine: string) => void {
  return (machine) => {
    cursor.record({ type: 'tools', key: machine, sessionId: null, accountId: null });
  };
}
