// The GitHub background sync (decision 0015, #356): the core reads GitHub on a timer and keeps what it
// read in the database; the screens answer from the database and never wait for GitHub when something
// is already there.
//
// | Step        | Every  | What it reads                                                             |
// | ----------- | ------ | ------------------------------------------------------------------------- |
// | `project`   | 2 min  | the chosen Project's board (decision 0001's key and query)                |
// | `decisions` | 15 min | the account's repositories and the ADR/PDR index; content only on a push  |
//
// One step at a time, in the order given, on the core's single GitHub queue (the steps' own services
// enqueue their calls). A step is due at start and then `everyMs` after it last ran, ok or not. While
// GitHub has paused the core (403/429), no step runs: the tick after the pause picks them up. A step
// answers `skipped` when there is nothing to read (GitHub not connected, no Project chosen), and
// `pending` when what it needs is not ready yet: it runs again on the next tick.

/** One step of the sync. `run` reads GitHub and stores; it answers whether there was anything to read. */
export interface SyncStep {
  name: string;
  everyMs: number;
  run(): Promise<'done' | 'skipped' | 'pending'>;
}

export interface SyncStepStatus {
  name: string;
  everyMs: number;
  running: boolean;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastDurationMs: number | null;
  lastOutcome: 'done' | 'skipped' | 'pending' | 'error' | null;
  error: string | null;
  nextAt: string | null;
}

export interface SyncStatus {
  /** `false` before `start` and after `stop`. */
  active: boolean;
  /** ISO of the end of GitHub's rate-limit pause, while it lasts. */
  pausedUntil: string | null;
  steps: SyncStepStatus[];
}

export interface GithubBackgroundSyncOptions {
  steps: SyncStep[];
  now?: () => number;
  /** How much of GitHub's rate-limit pause is left (the shared cache's). */
  pauseLeftMs?: () => number;
  /** How often the timer looks for due steps. Default 15 s. */
  tickMs?: number;
  log?: (message: string) => void;
}

export const SYNC_PROJECT_EVERY_MS = 2 * 60_000;
export const SYNC_DECISIONS_EVERY_MS = 15 * 60_000;
export const SYNC_TICK_MS = 15_000;

interface StepState {
  step: SyncStep;
  running: boolean;
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
  outcome: SyncStepStatus['lastOutcome'];
  error: string | null;
  /** When it is due; `0` is now. */
  nextAt: number;
  /** `requestNow` while it ran: due again as soon as it ends, not after its interval. */
  requested: boolean;
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class GithubBackgroundSync {
  private readonly states: StepState[];
  private readonly now: () => number;
  private readonly pauseLeftMs: () => number;
  private readonly tickMs: number;
  private readonly log: (message: string) => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking: Promise<void> | null = null;

  constructor({ steps, now = Date.now, pauseLeftMs = () => 0, tickMs = SYNC_TICK_MS, log = () => {} }: GithubBackgroundSyncOptions) {
    this.states = steps.map((step) => ({ step, running: false, startedAt: null, finishedAt: null, durationMs: null, outcome: null, error: null, nextAt: 0, requested: false }));
    this.now = now;
    this.pauseLeftMs = pauseLeftMs;
    this.tickMs = tickMs;
    this.log = log;
  }

  /** Runs the due steps now and then on every tick. The timer does not keep the process alive. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    this.timer.unref?.();
    void this.tick();
  }

  /** Stops the timer and waits for the step that is running. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.ticking;
  }

  /** Runs the due steps, one at a time; a tick while another runs waits for it instead of overlapping. */
  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.runDue().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  /** Makes a step due now (an identity reset, in cli.ts) and runs it on the next tick. */
  requestNow(name: string): void {
    const s = this.states.find((x) => x.step.name === name);
    if (!s) return;
    s.nextAt = 0;
    if (s.running) s.requested = true;
  }

  status(): SyncStatus {
    const pause = this.pauseLeftMs();
    return {
      active: this.timer !== null,
      pausedUntil: pause > 0 ? iso(this.now() + pause) : null,
      steps: this.states.map((s) => ({
        name: s.step.name,
        everyMs: s.step.everyMs,
        running: s.running,
        lastStartedAt: iso(s.startedAt),
        lastFinishedAt: iso(s.finishedAt),
        lastDurationMs: s.durationMs,
        lastOutcome: s.outcome,
        error: s.error,
        nextAt: iso(s.nextAt === 0 ? this.now() : s.nextAt),
      })),
    };
  }

  private async runDue(): Promise<void> {
    for (const s of this.states) {
      if (this.pauseLeftMs() > 0) return;
      if (this.now() < s.nextAt) continue;
      s.running = true;
      s.startedAt = this.now();
      try {
        s.outcome = await s.step.run();
        s.error = null;
      } catch (err) {
        s.outcome = 'error';
        s.error = reason(err);
        this.log(`github sync: ${s.step.name} failed: ${s.error}`);
      } finally {
        s.running = false;
        s.finishedAt = this.now();
        s.durationMs = s.finishedAt - s.startedAt;
        s.nextAt = s.requested ? 0 : s.finishedAt + (s.outcome === 'pending' ? this.tickMs : s.step.everyMs);
        s.requested = false;
      }
    }
  }
}
