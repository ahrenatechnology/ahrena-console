/*
 * What the CPU governor runs on the real machine (#723, epic #720): `ps` to read, `renice` and `taskpolicy` to change, each
 * with a fixed argv through `execFile` (no shell, no sudo). The tools' own text never leaves this file: a failed run is
 * read for what it means (`denied`, `gone`, `failed`) and only that goes up.
 *
 * - `ps comm=` gives each pid's argv[0] (a full path on macOS, the process name on Linux), not the executable image; it is read
 *   last on its line so a path with spaces stays whole. The governor roots a session when its basename is `claude` or
 *   `codex` (#720/AC-5); the value never goes to a log.
 * - On Linux a Claude Code session's comm is a truncated version, so the real executable of each registered root pid is read
 *   with `readlink /proc/<pid>/exe` (no exec) and handed up with the config folder of the session file (#720/AC-3).
 */

import { execFile } from 'node:child_process';
import { attributeProcesses, normalizeStart, type ProcessSample, type RegisteredSession, type StartCheck } from '../../diagnosis/attribution.ts';
import { parsePsTree } from '../../diagnosis/adapters/parsers.ts';
import { NICE_TARGET, type RootOrigin } from '../model.ts';
import type { ChangeOutcome, MachineControl, Observation } from '../governor.ts';

export type ExecResult = { ok: true; stdout: string } | { ok: false; outcome: ChangeOutcome };
/** Runs one executable with an argv list, no shell. */
export type Exec = (file: string, args: readonly string[]) => Promise<ExecResult>;

const EXEC_TIMEOUT_MS = 5_000;
const EXEC_MAX_BYTES = 8 * 1024 * 1024;

/** What a tool's complaint means; the text itself is dropped. */
export function outcomeOf(stderr: string): ChangeOutcome {
  if (/not permitted|permission denied|EPERM/i.test(stderr)) return 'denied';
  if (/no such process|ESRCH/i.test(stderr)) return 'gone';
  return 'failed';
}

/** The real exec: `LC_ALL=C` and `TZ=UTC` so `ps` prints its start in the one form the attribution compares. */
export const systemExec: Exec = (file, args) =>
  new Promise<ExecResult>((resolve) => {
    execFile(file, [...args], { timeout: EXEC_TIMEOUT_MS, maxBuffer: EXEC_MAX_BYTES, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, windowsHide: true }, (err, stdout, stderr) => {
      if (!err) return resolve({ ok: true, stdout });
      resolve({ ok: false, outcome: outcomeOf(String(stderr)) });
    });
  });

export interface MachineControlDeps {
  exec: Exec;
  platform: 'darwin' | 'linux';
  /** #723: The live registered sessions (`<config>/sessions/<pid>.json`). */
  registered(): Promise<RegisteredSession[]>;
  /** #723: The collector's check of a registered `procStart` against the real start, for this OS (`DiagnosisCollector.startCheck`). */
  startCheck(registry: readonly RegisteredSession[], samples: readonly ProcessSample[]): Promise<StartCheck>;
  /** #720/AC-3: The real executable of a pid (Linux: `readlink /proc/<pid>/exe`); `null` when it cannot be read. Only called on Linux, for registered roots. */
  readImage?(pid: number): Promise<string | null>;
}

const isPid = (pid: number): boolean => Number.isInteger(pid) && pid > 0 && pid <= 4_194_304;

/** #720/AC-5: `pid nice comm` per line; `comm` (argv[0]) is the rest of the line, spaces included. */
function parseNice(stdout: string): { nice: Map<number, number>; executables: Map<number, string> } {
  const nice = new Map<number, number>();
  const executables = new Map<number, string>();
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(-?\d+)\s+(\S.*?)\s*$/.exec(line);
    if (!m) continue;
    nice.set(Number(m[1]), Number(m[2]));
    executables.set(Number(m[1]), m[3] ?? '');
  }
  return { nice, executables };
}

/** #720/AC-3: The origin of each registered root pid; a pid whose entries name different config folders has none (it cannot be trusted to either). */
async function originsOf(roots: readonly number[], registry: readonly RegisteredSession[], deps: MachineControlDeps): Promise<Map<number, RootOrigin>> {
  const origins = new Map<number, RootOrigin>();
  for (const pid of roots) {
    const dirs = new Set(registry.filter((e) => e.pid === pid).map((e) => e.configDir));
    const [configDir] = [...dirs];
    if (dirs.size !== 1 || configDir === undefined) continue;
    const image = deps.platform === 'linux' && deps.readImage ? await deps.readImage(pid) : null;
    origins.set(pid, image ? { configDir, image } : { configDir });
  }
  return origins;
}

export function createMachineControl(deps: MachineControlDeps): MachineControl {
  const change = async (file: string, args: string[]): Promise<ChangeOutcome> => {
    const r = await deps.exec(file, args);
    return r.ok ? 'done' : r.outcome;
  };
  return {
    async sample(): Promise<Observation | null> {
      const [tree, nice] = await Promise.all([deps.exec('ps', ['-axo', 'pid=,ppid=,pcpu=,lstart=,args=']), deps.exec('ps', ['-axo', 'pid=,nice=,comm='])]);
      if (!tree.ok || !nice.ok) return null;
      const samples = parsePsTree(tree.stdout);
      if (samples.length === 0) return null;
      const registry = await deps.registered();
      const attribution = attributeProcesses(samples, registry, await deps.startCheck(registry, samples));
      const roots = [...new Set(attribution.sessions.flatMap((t) => t.rootPids))];
      return { trees: attribution.sessions, ...parseNice(nice.stdout), origins: await originsOf(roots, registry, deps) };
    },
    async inspect(pid) {
      if (!isPid(pid)) return null;
      const r = await deps.exec('ps', ['-o', 'lstart=', '-p', String(pid)]);
      if (!r.ok) return null;
      const start = normalizeStart(r.stdout);
      return start === '' ? null : { start };
    },
    async renice(pid) {
      return isPid(pid) ? change('renice', [String(NICE_TARGET), '-p', String(pid)]) : 'failed';
    },
    async background(pid) {
      return isPid(pid) && deps.platform === 'darwin' ? change('taskpolicy', ['-b', '-p', String(pid)]) : 'failed';
    },
    async foreground(pid) {
      return isPid(pid) && deps.platform === 'darwin' ? change('taskpolicy', ['-B', '-p', String(pid)]) : 'failed';
    },
  };
}
