/*
 * Which agent session a process belongs to (#722, #720). Pure: a sample of the machine's processes and the
 * registry of live sessions go in, the session trees and the processes outside any session come out. No command,
 * no file, no clock lives here; the collector that reads the machine is `adapters/common.ts`.
 *
 * - A process belongs to a session when its own pid, or the pid of one of its ancestors (the `ppid` chain, at most
 *   `MAX_CLIMB_DEPTH` hops, a cycle ends it), is in the registry, is in the sample (so it is alive) and its `procStart`
 *   is verified against its real start by the `StartCheck` the collector supplies for its OS (#722). A reused pid has another start, so it is never taken for the session.
 * - The nearest such ancestor wins. A pid the registry lists for two different sessions, a registry entry with no
 *   `procStart` and a pid that is not in the sample all leave the process outside: a session is never guessed.
 * - `ProcessSample.start` has one form on every OS: the text `ps -o lstart=` prints in UTC (`Sat Nov 14 08:15:02 2026`),
 *   whitespace collapsed. `procStart` does not: macOS Claude Code writes that text (`lstartMatches` compares them, as the
 *   terminal opener does, api/terminal-launch.ts); Linux Claude Code writes `/proc/<pid>/stat` field 22, in clock ticks.
 * - For #723 (the CPU governor), before it acts on a session's root pid, call `collector.startCheck(registry, samples)`
 *   (`DiagnosisCollector`, adapters/common.ts) and `attributeProcesses(samples, registry, check)`, or `check(entry, sample)`
 *   on the root pid alone; each `SessionTree` lists its processes with their own `start` to re-check a pid the same way.
 */

import type { OutsideSessionLoad, SessionLoadItem } from './model.ts';

/** One process of the machine, as `ps -axo pid=,ppid=,pcpu=,lstart=,args=` reports it. */
export interface ProcessSample {
  pid: number;
  ppid: number;
  /** The real start, `ps` `lstart` in UTC. (#722) */
  start: string;
  /** The full command line (`args`); never leaves this layer whole: see `rootCommandOf`. (#722) */
  command: string;
  cpuPct: number;
}

/** A live session as the registry (`<config>/sessions/<pid>.json`) records it. */
export interface RegisteredSession {
  pid: number;
  sessionId: string;
  cwd: string | null;
  /** The start Claude Code wrote, in the form of `ProcessSample.start`; `null` when it wrote none. (#722) */
  procStart: string | null;
}

/** Every process that descends from one session, the registered root pids included. */
export interface SessionTree {
  sessionId: string;
  cwd: string | null;
  /** The registered pids of the session, ascending; a tree is rooted in each. (#722) */
  rootPids: number[];
  /** Ascending by pid, each with its own `start`. (#722) */
  processes: ProcessSample[];
}

export interface Attribution {
  sessions: SessionTree[];
  /** The processes that descend from no session. (#722) */
  outside: ProcessSample[];
}

/** The most ancestors the climb looks at; a longer chain is not a process tree an agent opens. */
export const MAX_CLIMB_DEPTH = 32;

const ROOT_COMMAND_WORDS = 2;
const WORD_MAX = 24;
const ROOT_COMMAND_MAX = 80;
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'ksh']);
/* A program that only launches a script: `node /opt/pnpm/pnpm.cjs test` is named after the script, `pnpm test`. (#722) */
const LAUNCHERS = new Set(['node', 'bun', 'deno', 'python', 'python3', 'ruby', 'tsx']);
const SCRIPT_EXTENSION = /\.(?:[cm]?js|ts|py|rb)$/;

/** The start with its whitespace collapsed, so `Nov  7` and `Nov 7` are the same. */
export const normalizeStart = (start: string): string => start.replace(/\s+/g, ' ').trim();

const round1 = (n: number): number => Math.round(n * 10) / 10;
const lastSegment = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/**
 * Whether the start a registry entry holds is the real start of its pid (#722). `procStart` has a form per OS: on macOS the
 * `ps` lstart text, on Linux field 22 of `/proc/<pid>/stat` in clock ticks. Only the collector can read the real one, so it
 * supplies the check for its OS (`DiagnosisCollector.startCheck`); the attribution stays pure and never parses either form.
 */
export type StartCheck = (entry: RegisteredSession, real: ProcessSample) => boolean;

/** macOS: `procStart` is the lstart text, compared with the sample's own start (#722). A missing `procStart` is never a match. */
export const lstartMatches: StartCheck = (entry, real) => entry.procStart !== null && normalizeStart(entry.procStart) === normalizeStart(real.start);

type Root = RegisteredSession | null | 'ambiguous';

export function attributeProcesses(samples: readonly ProcessSample[], registry: readonly RegisteredSession[], startMatches: StartCheck = lstartMatches): Attribution {
  const byPid = new Map(samples.map((p) => [p.pid, p]));
  const registeredAt = new Map<number, RegisteredSession[]>();
  for (const entry of registry) registeredAt.set(entry.pid, [...(registeredAt.get(entry.pid) ?? []), entry]);

  /* The session a pid is the root of: `null` when it is not (no entry, a dead pid, another start), `'ambiguous'` when two sessions claim it. (#722) */
  const rootOf = (pid: number): Root => {
    const real = byPid.get(pid);
    if (!real) return null;
    const live = (registeredAt.get(pid) ?? []).filter((e) => startMatches(e, real));
    if (new Set(live.map((e) => e.sessionId)).size > 1) return 'ambiguous';
    return live[0] ?? null;
  };

  const trees = new Map<string, SessionTree>();
  const outside: ProcessSample[] = [];
  for (const process of samples) {
    const root = climb(process, byPid, rootOf);
    if (!root) {
      outside.push(process);
      continue;
    }
    const tree = trees.get(root.sessionId) ?? { sessionId: root.sessionId, cwd: root.cwd, rootPids: [], processes: [] };
    if (!tree.rootPids.includes(root.pid)) tree.rootPids.push(root.pid);
    tree.processes.push(process);
    trees.set(root.sessionId, tree);
  }
  const byPidAsc = (a: ProcessSample, b: ProcessSample) => a.pid - b.pid;
  for (const tree of trees.values()) {
    tree.rootPids.sort((a, b) => a - b);
    tree.processes.sort(byPidAsc);
  }
  return { sessions: [...trees.values()], outside: outside.sort(byPidAsc) };
}

function climb(process: ProcessSample, byPid: ReadonlyMap<number, ProcessSample>, rootOf: (pid: number) => Root): RegisteredSession | null {
  const seen = new Set<number>();
  let current: ProcessSample | undefined = process;
  for (let hops = 0; current && hops <= MAX_CLIMB_DEPTH; hops++) {
    if (seen.has(current.pid)) return null;
    seen.add(current.pid);
    const root = rootOf(current.pid);
    if (root === 'ambiguous') return null;
    if (root) return root;
    current = byPid.get(current.ppid);
  }
  return null;
}

export const treeCpuPct = (tree: SessionTree): number => round1(tree.processes.reduce((sum, p) => sum + p.cpuPct, 0));

/** The load of one session; `title` is what the caller knows of it (`null` when nothing). */
export function loadOf(tree: SessionTree, title: string | null): SessionLoadItem {
  return { sessionId: tree.sessionId, title, rootCommand: rootCommandOf(tree), cwd: tree.cwd, processCount: tree.processes.length, cpuPct: treeCpuPct(tree) };
}

export function outsideLoadOf(attribution: Attribution): OutsideSessionLoad {
  return { processCount: attribution.outside.length, cpuPct: round1(attribution.outside.reduce((sum, p) => sum + p.cpuPct, 0)) };
}

/**
 * What the session is running, in a few words: from a root, take the child whose subtree carries the most CPU and go
 * down while that child is a shell wrapper (`zsh -c ...`, how the agent's Bash tool starts a command); the first
 * command that is not one names the session (`pnpm test`). A session with no such command is named by its own program.
 * The command line is never shown whole (it can carry a token or a prompt): only the program and up to two plain
 * words after it, a path by its last segment, and the line stops at the first flag, `name=value` or long word.
 * `node <script> ...` (a launcher) is named after the script, without its extension.
 */
export function rootCommandOf(tree: SessionTree): string {
  const children = new Map<number, ProcessSample[]>();
  for (const p of tree.processes) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p]);
  const subtreeCpu = (p: ProcessSample, seen = new Set<number>()): number => {
    if (seen.has(p.pid)) return 0;
    seen.add(p.pid);
    return p.cpuPct + (children.get(p.pid) ?? []).reduce((sum, c) => sum + subtreeCpu(c, seen), 0);
  };
  const heaviest = (pid: number): ProcessSample | null => {
    const kids = (children.get(pid) ?? []).map((k) => ({ k, cpu: subtreeCpu(k) }));
    kids.sort((a, b) => b.cpu - a.cpu || a.k.pid - b.k.pid);
    return kids[0]?.k ?? null;
  };
  const rootPid = tree.rootPids[0] ?? -1;
  let at = heaviest(rootPid);
  while (at && isShellWrapper(at.command)) at = heaviest(at.pid);
  return summarise(at?.command ?? tree.processes.find((p) => p.pid === rootPid)?.command ?? '');
}

function isShellWrapper(command: string): boolean {
  const [program = '', ...flags] = command.trim().split(/\s+/);
  return SHELLS.has(lastSegment(program).replace(/^-/, '')) && flags.slice(0, 3).some((f) => /^-[a-z]*c[a-z]*$/.test(f));
}

function summarise(command: string): string {
  const [program = '', ...tokens] = command.trim().split(/\s+/);
  const script = LAUNCHERS.has(lastSegment(program)) && tokens[0] && SCRIPT_EXTENSION.test(tokens[0]) ? lastSegment(tokens[0]).replace(SCRIPT_EXTENSION, '') : null;
  const rest = script === null ? tokens : tokens.slice(1);
  const words = [(script ?? lastSegment(program)).replace(/^-/, '').replace(/[^\w.@:+-]/g, '') || 'unknown'];
  for (const token of rest) {
    const word = lastSegment(token);
    if (words.length > ROOT_COMMAND_WORDS || token.startsWith('-') || token.includes('=') || word.length > WORD_MAX || !/^[\w.@:+-]+$/.test(word)) break;
    words.push(word);
  }
  return words.join(' ').slice(0, ROOT_COMMAND_MAX);
}
