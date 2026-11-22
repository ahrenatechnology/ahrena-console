/*
 * The CPU governor's policy (#723, epic #720). Pure: no command, no file, no clock. When the machine counts as saturated
 * (`nextPressure`) and which processes of a session tree the governor may touch (`targetsOf`).
 *
 * - The governor puts `nice 10` on every descendant of an agent session, and on a Mac under pressure also runs `taskpolicy -b`
 *   on them. Pressure is the 1-minute load above the core count for `CONTAIN_AFTER_MS` without a break; it ends when the load
 *   stays below `RELEASE_BELOW` of the cores for `RELEASE_AFTER_MS`. The load between the two thresholds keeps the mode.
 * - A session's root pid is never a target, even when it is listed in `SessionTree.processes`, and neither is the core itself
 *   or anything that descends from it: the core can have been started from a session.
 * - A root counts only when its pid is above 1 and either the argv[0] basename `ps comm` reports is `claude` or `codex`, or (a
 *   Linux Claude Code session, whose comm is a truncated version) its real executable sits directly in `<configDir>/remote/ccd-cli/`
 *   of the config folder whose `sessions/<pid>.json` registered it (`isAgentRoot`, #720/AC-3, #720/AC-5): the registry file is
 *   data a person can write, so a `1.json` or a root running anything else yields no target, whatever descends from it.
 * - Residual risk, accepted: on macOS `ps comm` is argv[0], not the executable image, so a same-user process that sets its
 *   argv[0] to `claude` or `codex` and has a forged registry entry gets its own descendants governed; pid 1 and the Desktop stay safe.
 */

import { basename, dirname, isAbsolute, join, normalize } from 'node:path/posix';
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

/** #720/AC-5: The argv[0] basenames a session may be rooted in: the segment after the last `/` of `ps comm`, exactly. */
const AGENT_EXECUTABLES: ReadonlySet<string> = new Set(['claude', 'codex']);

/** #720/AC-3: Where a registered root came from: the config folder of its session file, and (Linux) the real executable read from /proc. */
export interface RootOrigin {
  configDir: string;
  image?: string;
}

const DELETED_SUFFIX = ' (deleted)';

/**
 * #720/AC-3: The real executable sits directly in `<configDir>/remote/ccd-cli/`, both paths absolute and already normalized (no `..`, no `//`).
 * A link the kernel marks ` (deleted)` is a binary replaced while it runs (an auto-update): the session is still the one that was installed
 * there, so the mark is dropped and the folder is checked as for any other.
 */
function inCcdCli(origin: RootOrigin | undefined): boolean {
  if (!origin?.image) return false;
  const { configDir } = origin;
  const image = origin.image.endsWith(DELETED_SUFFIX) ? origin.image.slice(0, -DELETED_SUFFIX.length) : origin.image;
  if (!isAbsolute(configDir) || !isAbsolute(image) || normalize(configDir) !== configDir || normalize(image) !== image) return false;
  return basename(image) !== '' && dirname(image) === join(configDir, 'remote', 'ccd-cli');
}

/**
 * #720/AC-5: Whether a registered pid may root a session: above pid 1 (so never launchd or init) and either running a `claude` or
 * `codex` argv[0] by its basename (as `ps comm` reports it), not by a substring of a path or a command line, or (#720/AC-3) running
 * an executable that sits directly in the `remote/ccd-cli/` folder of the config folder that registered it. No `comm` and no origin is not a root.
 */
export function isAgentRoot(pid: number, executable: string | undefined, origin?: RootOrigin): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  if (executable !== undefined && AGENT_EXECUTABLES.has(executable.slice(executable.lastIndexOf('/') + 1).trim())) return true;
  return inCcdCli(origin);
}

/** A session root the governor refuses: its session, pid and the start it was sampled with. */
export interface RefusedRoot {
  sessionId: string;
  pid: number;
  start: string;
}

/** The registered roots that are not an agent root: their trees yield no target. */
export function refusedRoots(trees: readonly SessionTree[], executables: ReadonlyMap<number, string>, origins: ReadonlyMap<number, RootOrigin> = new Map()): RefusedRoot[] {
  const refused: RefusedRoot[] = [];
  for (const tree of trees) {
    for (const pid of tree.rootPids) {
      if (isAgentRoot(pid, executables.get(pid), origins.get(pid))) continue;
      refused.push({ sessionId: tree.sessionId, pid, start: tree.processes.find((p) => p.pid === pid)?.start ?? '' });
    }
  }
  return refused;
}

/**
 * The descendants of each session, by pid ascending per session; never a root pid, `protectedPids` or what descends from one,
 * and only under a root that is an agent root (`isAgentRoot`): a process whose nearest root is anything else is not a target.
 */
export function targetsOf(trees: readonly SessionTree[], protectedPids: ReadonlySet<number>, executables: ReadonlyMap<number, string>, origins: ReadonlyMap<number, RootOrigin> = new Map()): Target[] {
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
    /* #720/AC-5: The nearest root above a process, climbing its parents; none when the climb ends before a root. */
    const rootOf = (pid: number): number | undefined => {
      const seen = new Set<number>();
      for (let at: number | undefined = pid; at !== undefined && !seen.has(at); at = parentOf.get(at)) {
        if (roots.has(at)) return at;
        seen.add(at);
      }
      return undefined;
    };
    for (const p of tree.processes) {
      if (roots.has(p.pid) || shielded(p.pid)) continue;
      const root = rootOf(p.pid);
      if (root === undefined || !isAgentRoot(root, executables.get(root), origins.get(root))) continue;
      targets.push({ sessionId: tree.sessionId, pid: p.pid, start: p.start });
    }
  }
  return targets;
}
