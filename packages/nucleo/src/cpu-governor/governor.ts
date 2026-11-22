/*
 * The CPU governor's loop (#723, epic #720). One tick samples the machine, decides the mode from the load, and changes only
 * the descendants of an agent session: `renice 10` when their nice is below 10, and in `containing` mode on a Mac also
 * `taskpolicy -b`. Everything it touches goes through `MachineControl`, so the loop is tested with a double.
 *
 * - A session root is only a pid above 1 whose argv[0] basename (`ps comm`) is `claude` or `codex`; any other root is refused (no target in its
 *   tree) and logged once by pid, never by its command or path (#720/AC-5).
 * - It only raises nice (never lowers), never uses sudo, never ends a process (#647), and undoes only what it set itself:
 *   `taskpolicy -B` on the pids it put under `-b`; the nice stays, because lowering it needs privilege.
 * - Before every change it asks the machine for the pid's current start and skips the pid when it is not the one sampled (a
 *   reused pid) or is gone. A refused change (`denied`) is logged by operation, pid and outcome, and not retried for that pid.
 * - A failed tick logs its operation only: never the error's text, which can name a path.
 * - The state lives in memory: on at boot, `setEnabled` turns it on or off. Ticks and `setEnabled` run one at a time.
 */

import { normalizeStart, type SessionTree } from '../diagnosis/attribution.ts';
import { initialPressure, nextPressure, NICE_TARGET, refusedRoots, targetsOf, type GovernorState, type LoadReading, type Pressure, type Target } from './model.ts';

export type ChangeOutcome = 'done' | 'denied' | 'gone' | 'failed';

/** What one reading of the machine gives: the session trees by the attribution, and the nice of every pid. */
export interface Observation {
  trees: readonly SessionTree[];
  nice: ReadonlyMap<number, number>;
  /** #720/AC-5: The argv[0] basename of every pid (`ps comm`), to tell a `claude` or `codex` root from anything else. */
  executables: ReadonlyMap<number, string>;
}

/** The only commands the governor runs, each with a fixed argv, no shell, no sudo. */
export interface MachineControl {
  sample(): Promise<Observation | null>;
  /** #723: The pid's current start in the form of `ProcessSample.start`; `null` when it is gone. */
  inspect(pid: number): Promise<{ start: string } | null>;
  /** #723: `renice 10 -p <pid>`. */
  renice(pid: number): Promise<ChangeOutcome>;
  /** #723: `taskpolicy -b -p <pid>` (macOS). */
  background(pid: number): Promise<ChangeOutcome>;
  /** #723: `taskpolicy -B -p <pid>` (macOS). */
  foreground(pid: number): Promise<ChangeOutcome>;
}

export interface CpuGovernorDeps {
  machine: MachineControl;
  load(): LoadReading;
  nowMs(): number;
  log(message: string): void;
  /** #723: `taskpolicy` exists only on darwin: elsewhere the governor only raises the nice. */
  platform: 'darwin' | 'linux';
  /** #723: The core's own pid: never a target, nor anything under it. */
  selfPid: number;
}

/** #723: A change it made that it may undo: the pid, the start it had and its session. */
interface BackgroundEntry {
  start: string;
  sessionId: string;
}

const keyOf = (pid: number, start: string): string => `${pid}:${normalizeStart(start)}`;

export class CpuGovernor {
  private readonly d: CpuGovernorDeps;
  private enabled = true;
  private pressure: Pressure = initialPressure();
  private since: number;
  /** #723: Pids it reniced or found at nice 10 or more, and pids whose `-b` was tried (also the refused). */
  private readonly settled = new Set<string>();
  private readonly triedBackground = new Set<string>();
  /** #723: The pids it put under `-b`, which it takes out again. */
  private readonly background = new Map<number, BackgroundEntry>();
  /** #720/AC-5: The roots already logged as refused, so a refused root is logged once, not on every tick. */
  private readonly refused = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  /** #723: A tick the timer started and that has not ended: the timer skips its beat meanwhile, so slow ticks do not pile up. */
  private ticking = false;

  constructor(deps: CpuGovernorDeps) {
    this.d = deps;
    this.since = deps.nowMs();
  }

  state(): GovernorState {
    const sessions = new Set([...this.background.values()].map((s) => s.sessionId));
    return { enabled: this.enabled, mode: this.pressure.mode, containedSessions: [...sessions].sort(), since: new Date(this.since).toISOString() };
  }

  /** #723: Runs `tick` every `intervalMs`; the timer does not hold the process open. */
  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.ticking) return;
      this.ticking = true;
      void this.tick().finally(() => (this.ticking = false));
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tick(): Promise<void> {
    return this.serial(async () => {
      if (!this.enabled) return;
      try {
        await this.run();
      } catch {
        this.d.log('cpu-governor tick failed');
      }
    });
  }

  /** #723: Turning it off takes `-b` off the pids it set (nothing else, no renice) and the mode returns to `normal`. */
  setEnabled(enabled: boolean): Promise<void> {
    return this.serial(async () => {
      if (enabled === this.enabled) return;
      this.enabled = enabled;
      this.since = this.d.nowMs();
      this.pressure = initialPressure();
      if (!enabled) await this.release();
    });
  }

  private serial(task: () => Promise<void>): Promise<void> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async run(): Promise<void> {
    const observation = await this.d.machine.sample();
    if (!observation) return;
    const now = this.d.nowMs();
    const before = this.pressure.mode;
    this.pressure = nextPressure(this.pressure, this.d.load(), now, this.d.platform === 'darwin');
    if (this.pressure.mode !== before) this.since = now;
    if (before === 'containing' && this.pressure.mode === 'normal') await this.release();

    this.logRefused(observation);
    const targets = targetsOf(observation.trees, new Set([this.d.selfPid]), observation.executables);
    this.forget(targets);
    await this.pruneBackground(targets);
    for (const target of targets) {
      const nice = observation.nice.get(target.pid);
      const key = keyOf(target.pid, target.start);
      if (nice !== undefined && nice < NICE_TARGET && !this.settled.has(key)) {
        this.settled.add(key);
        await this.change(target, 'renice', (pid) => this.d.machine.renice(pid));
      } else if (nice !== undefined) this.settled.add(key);
      if (this.pressure.mode === 'containing' && !this.triedBackground.has(key)) {
        this.triedBackground.add(key);
        if ((await this.change(target, 'background', (pid) => this.d.machine.background(pid))) === 'done') this.background.set(target.pid, { start: target.start, sessionId: target.sessionId });
      }
    }
  }

  /** #720/AC-5: Logs each refused root once, by pid; an entry that left the sample is forgotten, so it is logged again if it returns. */
  private logRefused(observation: Observation): void {
    const now = new Map(refusedRoots(observation.trees, observation.executables).map((r) => [keyOf(r.pid, r.start), r.pid]));
    for (const key of this.refused) if (!now.has(key)) this.refused.delete(key);
    for (const [key, pid] of now) {
      if (this.refused.has(key)) continue;
      this.refused.add(key);
      this.d.log(`cpu-governor root refused: pid=${pid}`);
    }
  }

  /** #723: Drops what it remembers about pids that are not in the sample any more, except the pids under `-b`, which it must still undo. */
  private forget(targets: readonly Target[]): void {
    const live = new Set(targets.map((t) => keyOf(t.pid, t.start)));
    for (const key of this.settled) if (!live.has(key)) this.settled.delete(key);
    for (const key of this.triedBackground) if (!live.has(key)) this.triedBackground.delete(key);
  }

  /**
   * #723: A pid under `-b` that left every tree stays in `background` (the process may be alive, reparented or detached) until
   * `release` takes it out; only when it is gone or is another process now is its entry dropped, since there is nothing to undo.
   */
  private async pruneBackground(targets: readonly Target[]): Promise<void> {
    const live = new Set(targets.map((t) => keyOf(t.pid, t.start)));
    for (const [pid, set] of [...this.background]) {
      if (live.has(keyOf(pid, set.start))) continue;
      const now = await this.d.machine.inspect(pid);
      if (!now || normalizeStart(now.start) !== normalizeStart(set.start)) this.background.delete(pid);
    }
  }

  /** #723: One change with the start check before it; `skipped` when the pid is gone or reused. */
  private async change(target: Target, operation: string, run: (pid: number) => Promise<ChangeOutcome>): Promise<ChangeOutcome | 'skipped'> {
    const outcome = await this.verified(target.pid, target.start, run);
    if (outcome !== 'skipped' && outcome !== 'done') this.d.log(`cpu-governor ${operation} ${outcome}: pid=${target.pid}`);
    return outcome;
  }

  private async verified(pid: number, start: string, run: (pid: number) => Promise<ChangeOutcome>): Promise<ChangeOutcome | 'skipped'> {
    const now = await this.d.machine.inspect(pid);
    if (!now || normalizeStart(now.start) !== normalizeStart(start)) return 'skipped';
    return run(pid);
  }

  /** #723: `taskpolicy -B` on the pids it put under `-b`, each after its start check. */
  private async release(): Promise<void> {
    const mine = [...this.background];
    this.background.clear();
    this.triedBackground.clear();
    for (const [pid, set] of mine) {
      const outcome = await this.verified(pid, set.start, (p) => this.d.machine.foreground(p));
      if (outcome !== 'skipped' && outcome !== 'done') this.d.log(`cpu-governor foreground ${outcome}: pid=${pid}`);
    }
  }
}
