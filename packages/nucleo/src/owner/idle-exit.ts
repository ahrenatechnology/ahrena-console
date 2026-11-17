// When a core started with `--parent` may exit (decision 0027, issue #706). The core stays up while its
// parent or any client lives; once none is left, it waits an idle grace period before exiting, and a
// client that attaches during the grace cancels it. The grace covers the gap between one Claude
// session ending and the next one starting, so the next bridge finds the core already up instead of
// starting another one (and re-importing the history).

/** Eight hours: a working day's gaps (lunch, meetings, a closed laptop lid) without a restart. */
export const DEFAULT_IDLE_GRACE_MS = 8 * 60 * 60 * 1000;

/** Seconds of idle grace; `0` exits as soon as the last client is gone (the behaviour before #706). */
export const IDLE_GRACE_ENV = 'AHRENA_CONSOLE_IDLE_GRACE_SECONDS';

/** The grace from the environment, else the default. Throws on a value that is not a whole number of seconds. */
export function resolveIdleGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[IDLE_GRACE_ENV];
  if (raw === undefined || raw === '') return DEFAULT_IDLE_GRACE_MS;
  const seconds = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(seconds)) throw new Error(`${IDLE_GRACE_ENV}: a whole number of seconds, 0 or more (got "${raw}")`);
  return seconds * 1000;
}

/**
 * What one check of the watcher concludes:
 * - `in-use`: the parent or some client lives;
 * - `idle-started`: nobody is left, and the grace starts now;
 * - `idle`: still nobody, within the grace;
 * - `expired`: nobody for the whole grace: the core exits.
 */
export type IdleVerdict = 'in-use' | 'idle-started' | 'idle' | 'expired';

/** The idle grace as a clock-free state machine: each check says whether someone is using the core. */
export class IdleExit {
  private idleSince: number | null = null;
  private readonly graceMs: number;

  constructor(graceMs: number) {
    this.graceMs = graceMs;
  }

  observe(inUse: boolean, now: number): IdleVerdict {
    if (inUse) {
      this.idleSince = null;
      return 'in-use';
    }
    if (this.idleSince === null) {
      this.idleSince = now;
      return this.graceMs <= 0 ? 'expired' : 'idle-started';
    }
    return now - this.idleSince >= this.graceMs ? 'expired' : 'idle';
  }
}

/** The grace in words for the log line: `8 h`, `90 min`, `30 s`. */
export function describeGrace(ms: number): string {
  if (ms > 0 && ms % 3_600_000 === 0) return `${ms / 3_600_000} h`;
  if (ms > 0 && ms % 60_000 === 0) return `${ms / 60_000} min`;
  return `${Math.round(ms / 1000)} s`;
}
