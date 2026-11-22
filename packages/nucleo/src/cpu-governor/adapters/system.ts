/*
 * What the CPU governor runs on the real machine (#723, epic #720): `ps` to read, `renice` and `taskpolicy` to change, each
 * with a fixed argv through `execFile` (no shell, no sudo). The tools' own text never leaves this file: a failed run is
 * read for what it means (`denied`, `gone`, `failed`) and only that goes up.
 *
 * - `ps comm=` gives each pid's argv[0] (a full path on macOS, the process name on Linux), not the executable image; it is read
 *   last on its line so a path with spaces stays whole. The governor roots a session only when its basename is `claude` or
 *   `codex` (#720/AC-5); the value never goes to a log.
 */

import { execFile } from 'node:child_process';
import { attributeProcesses, normalizeStart, type ProcessSample, type RegisteredSession, type StartCheck } from '../../diagnosis/attribution.ts';
import { parsePsTree } from '../../diagnosis/adapters/parsers.ts';
import { NICE_TARGET } from '../model.ts';
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
      return { trees: attribution.sessions, ...parseNice(nice.stdout) };
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
