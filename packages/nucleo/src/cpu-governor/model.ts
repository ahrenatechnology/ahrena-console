/*
 * The CPU governor's policy (#723, epic #720). Pure: no command, no file, no clock. When the machine counts as saturated
 * (`nextPressure`) and which processes of a session tree the governor may touch (`targetsOf`).
 *
 * - The governor puts `nice 10` on every descendant of an agent session, and on a Mac under pressure also runs `taskpolicy -b`
 *   on them. Pressure is the 1-minute load above the core count for `CONTAIN_AFTER_MS` without a break; it ends when the load
 *   stays below `RELEASE_BELOW` of the cores for `RELEASE_AFTER_MS`. The load between the two thresholds keeps the mode.
 * - A session's root pid (`claude` or `codex`) is never a target, even when it is listed in `SessionTree.processes`, and
 *   neither is the core itself or anything that descends from it: the core can have been started from a session.
 */

import type { SessionTree } from '../diagnosis/attribution.ts';

/** The nice the governor sets; it only raises a process to this value, never lowers one. */
export const NICE_TARGET = 10;
/** The load above the cores must last this long before containing starts. */
export const CONTAIN_AFTER_MS = 30_000;
/** The load below `RELEASE_BELOW` of the cores must last this long before containing ends. */
export const RELEASE_AFTER_MS = 120_000;
export const RELEASE_BELOW = 0.8;

export type GovernorMode = 'normal' | 'containing';

/** What `GET /api/telemetry` carries about the governor (this machine only). */
export interface GovernorState {
  enabled: boolean;
  mode: GovernorMode;
  /** #723: The sessions that have a process under `taskpolicy -b` now; empty in `normal`. */
  containedSessions: string[];
  /** #723: ISO time the governor was last turned on or off, or its mode last changed. */
  since: string;
}

export interface Pressure {
  mode: GovernorMode;
  /** #723: When the load first went above the cores in this run of readings; `null` when it is not above. */
  overSince: number | null;
  /** #723: When the load first went below `RELEASE_BELOW` of the cores in this run; `null` when it is not below. */
  underSince: number | null;
}

export interface LoadReading {
  load1: number;
  cores: number;
}

export const initialPressure = (): Pressure => ({ mode: 'normal', overSince: null, underSince: null });

/** The next pressure after one reading. A machine that cannot contain (`canContain` false) stays `normal`. */
export function nextPressure(pressure: Pressure, load: LoadReading, nowMs: number, canContain: boolean): Pressure {
  if (!canContain) return initialPressure();
  if (pressure.mode === 'normal') {
    if (load.load1 <= load.cores) return initialPressure();
    const overSince = pressure.overSince ?? nowMs;
    return nowMs - overSince >= CONTAIN_AFTER_MS ? { mode: 'containing', overSince: null, underSince: null } : { mode: 'normal', overSince, underSince: null };
  }
  if (load.load1 >= load.cores * RELEASE_BELOW) return { mode: 'containing', overSince: null, underSince: null };
  const underSince = pressure.underSince ?? nowMs;
  return nowMs - underSince >= RELEASE_AFTER_MS ? initialPressure() : { mode: 'containing', overSince: null, underSince };
}

/** A process the governor may change: its session and the start it was sampled with, to check before the change. */
export interface Target {
  sessionId: string;
  pid: number;
  start: string;
}

/** The descendants of each session, by pid ascending per session; never a root pid, `protectedPids` or what descends from one. */
export function targetsOf(trees: readonly SessionTree[], protectedPids: ReadonlySet<number>): Target[] {
  const targets: Target[] = [];
  for (const tree of trees) {
    const roots = new Set(tree.rootPids);
    const parentOf = new Map(tree.processes.map((p) => [p.pid, p.ppid]));
    /* #723: The parent only counts while it is in the tree: a pid above it (the core that started the session) shields nothing. */
    const parentInTree = (pid: number): number | undefined => {
      const parent = parentOf.get(pid);
      return parent !== undefined && parentOf.has(parent) ? parent : undefined;
    };
    const shielded = (pid: number): boolean => {
      const seen = new Set<number>();
      for (let at: number | undefined = pid; at !== undefined && !seen.has(at); at = parentInTree(at)) {
        if (protectedPids.has(at)) return true;
        seen.add(at);
      }
      return false;
    };
    for (const p of tree.processes) {
      if (roots.has(p.pid) || shielded(p.pid)) continue;
      targets.push({ sessionId: tree.sessionId, pid: p.pid, start: p.start });
    }
  }
  return targets;
}
