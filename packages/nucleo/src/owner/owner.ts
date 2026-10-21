// One core per installation (decision 0010; issue #86). Whoever starts first serves; the others
// adopt, unless the live core is of an older version (issue #220): then it is replaced.
//
//   1. `examine`: the lock says pid and port. It is alive if the port answers as a core **with the
//      same pid** (`/api/overview` says who it is). Otherwise the lock is an orphan, and whoever is
//      starting recovers it.
//   2. `reservePort` (probe.ts): only whoever holds the port opens the database. Two starts at the
//      same time give a single core, because the system gives the port to one; the other waits for
//      the core to answer and adopts it.
//   3. `claimLock`: with the API already listening, the core creates the lock (exclusive).
//   4. `watchParent`: with `--parent`, the core exits when the parent and every registered client
//      are gone.
//
// The `reason` and `warning` texts stay in Portuguese: they reach the `--json` line (`motivo`,
// `aviso`) and the desktop app shows them on screen.

import { execFileSync } from 'node:child_process';
import { liveClients } from './clients.ts';
import { compareVersions, sleep, probeCore, isPidAlive, type CoreView } from './probe.ts';
import { createLock, releaseLock, newToken, defaultDir, readLock, removeLock, type Lock } from './lock.ts';

export type Examination =
  | { state: 'absent' }
  | { state: 'alive'; lock: Lock; view: CoreView }
  | { state: 'orphan'; lock: Lock | null; reason: string };

export async function examine(dir = defaultDir()): Promise<Examination> {
  const t = readLock(dir);
  if (t === null) return { state: 'absent' };
  if (t === 'invalid') return { state: 'orphan', lock: null, reason: 'trava ilegível' };
  if (!isPidAlive(t.pid)) return { state: 'orphan', lock: t, reason: `o pid ${t.pid} não existe mais` };
  const view = await probeCore(t.port);
  if (!view) return { state: 'orphan', lock: t, reason: `a porta ${t.port} não responde como núcleo` };
  // The lock's pid may have been reused by another process, with another core on the port.
  if (view.pid !== t.pid) return { state: 'orphan', lock: t, reason: `a porta ${t.port} é de outro processo (pid ${view.pid ?? '?'}), não do pid ${t.pid}` };
  return { state: 'alive', lock: t, view };
}

/** Whoever is starting: the version and commit of the code (src/owner/commit.ts). */
export interface CodeIdentity {
  version: string;
  commit: string | null;
  /** `true` if the given commit is older than this one (an ancestor). Without it, none is. */
  isOlderCommit?: (commit: string) => boolean;
}

export type CodeComparison = 'same' | 'newer' | 'older' | 'other-code';

/** Compares the running core with whoever is starting: by version and, on the same version, by commit. */
export function compareCode(running: { version: string; commit: string | null }, mine: CodeIdentity): CodeComparison {
  const v = compareVersions(running.version, mine.version);
  if (v > 0) return 'newer';
  if (v < 0) return 'older';
  if (!running.commit || !mine.commit || running.commit === mine.commit) return 'same';
  return mine.isOlderCommit?.(running.commit) ? 'older' : 'other-code';
}

/** The warning for whoever adopts a core of other code. `null` if it is the same (or newer). */
export function codeWarning(running: { version: string; commit: string | null; pid: number | null }, mine: CodeIdentity): string | null {
  const c = compareCode(running, mine);
  const who = `o núcleo de pé${running.pid ? ` (pid ${running.pid})` : ''}`;
  if (c === 'older' && compareVersions(running.version, mine.version) < 0) {
    return `${who} é a versão ${running.version}, mais velha que esta (${mine.version}). Ele continua servindo; para trocar, pare-o (npm run core -- stop)`;
  }
  if (c === 'older') {
    return `${who} roda o commit ${running.commit}, mais velho que este (${mine.commit}). Ele continua servindo; para trocar, suba com --replace`;
  }
  if (c === 'other-code') {
    return `${who} roda o commit ${running.commit}, que não é este (${mine.commit}) nem um ancestral dele. Ele continua servindo; pare-o (npm run core -- stop) para subir este`;
  }
  return null;
}

export type StartPlan =
  | { action: 'adopt'; lock: Lock; view: CoreView; warning: string | null }
  | { action: 'start'; recovered: string | null; replaced: Lock | null };

export interface StartPlanOptions extends CodeIdentity {
  dir?: string;
  /**
   * If the live core runs an ancestor commit of the same version, stops it and starts this one. A
   * live core of an older **version** is always replaced (issue #220), with or without it.
   */
  replace?: boolean;
  log?: (m: string) => void;
}

/** What to do before opening the database: adopt the live core, or start (recovering an orphan lock). */
export async function planStart(o: StartPlanOptions): Promise<StartPlan> {
  const dir = o.dir ?? defaultDir();
  const ex = await examine(dir);
  if (ex.state === 'absent') return { action: 'start', recovered: null, replaced: null };
  if (ex.state === 'orphan') return { action: 'start', recovered: ex.reason, replaced: null };
  const running = { version: ex.lock.version, commit: ex.view.commit, pid: ex.lock.pid };
  // Issue #220: an updated app found its installation's core of the previous version still up (kept
  // alive by the MCP bridges registered as its clients) and adopted it, so the window showed the old
  // /ui. An older version is replaced on its own; an ancestor commit of the same version (two
  // checkouts) only with `replace`, and other code never.
  const olderVersion = compareVersions(running.version, o.version) < 0;
  if (compareCode(running, o) !== 'older' || !(olderVersion || o.replace)) {
    return { action: 'adopt', lock: ex.lock, view: ex.view, warning: codeWarning(running, o) };
  }
  o.log?.(`replacing the core ${running.version}${running.commit ? ` (${running.commit})` : ''}, pid ${running.pid}, with this one (${o.version})`);
  if (!(await stopCore(ex.lock, { dir }))) throw new ReplaceError(running);
  return { action: 'start', recovered: null, replaced: ex.lock };
}

/** The older core did not exit when asked to. `reason` is pt-BR: it reaches the app's tray. */
export class ReplaceError extends Error {
  readonly reason: string;
  constructor(running: { version: string; pid: number | null }) {
    super(`the old core (version ${running.version}, pid ${running.pid}) did not exit`);
    this.reason = `o núcleo antigo (versão ${running.version}, pid ${running.pid}) não saiu para dar lugar a este`;
  }
}

/**
 * Creates this process's lock, with the API already listening on `port`. Creation is exclusive: if
 * there is a live lock of another core (started at the same time, on another port), returns it, and
 * the caller closes and adopts. An orphan lock is moved out of the way (only if it is still the same)
 * and creation tries again.
 */
export async function claimLock(o: { dir?: string; port: number; version: string; parent: number | null }): Promise<Lock | { conflict: Lock }> {
  const dir = o.dir ?? defaultDir();
  const lock: Lock = { pid: process.pid, port: o.port, version: o.version, startedAt: new Date().toISOString(), token: newToken(), parent: o.parent };
  for (let attempt = 0; attempt < 10; attempt++) {
    if (createLock(lock, dir)) return lock;
    const ex = await examine(dir);
    if (ex.state === 'alive') {
      if (ex.lock.pid === process.pid) return ex.lock;
      return { conflict: ex.lock };
    }
    if (ex.state === 'orphan') removeLock(ex.lock?.token ?? null, dir);
  }
  throw new Error('could not create the lock: another start keeps replacing it');
}

/** Stops only if the port still answers as this core; or, with no answer, if the pid still runs the API. */
async function isStillTheCore(t: Lock): Promise<boolean> {
  if (!isPidAlive(t.pid)) return false;
  const v = await probeCore(t.port, 500);
  if (v) return v.pid === t.pid;
  // The port already closed (the core is exiting) or hung: check the process command.
  try {
    const cmd = execFileSync('ps', ['-o', 'command=', '-p', String(t.pid)], { encoding: 'utf8', timeout: 2_000 });
    return /node/.test(cmd) && /src[/\\]api[/\\]cli\.ts/.test(cmd);
  } catch {
    return false;
  }
}

/**
 * SIGTERM; if it has not exited within `timeoutMs`, SIGKILL. Before each signal, checks that the pid
 * is still the core's (never a process that inherited the number). Deletes the lock if it is still
 * its own. `false` if it was not the core or if it did not exit.
 */
export async function stopCore(t: Lock, o: { dir?: string; timeoutMs?: number } = {}): Promise<boolean> {
  const dir = o.dir ?? defaultDir();
  const waitForExit = async (ms: number) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (!isPidAlive(t.pid)) return true;
      await sleep(50);
    }
    return !isPidAlive(t.pid);
  };
  const signal = async (s: NodeJS.Signals) => {
    if (!(await isStillTheCore(t))) return false;
    try {
      process.kill(t.pid, s);
    } catch {
      /* just exited */
    }
    return true;
  };
  if (!(await signal('SIGTERM'))) {
    if (isPidAlive(t.pid)) return false;
    releaseLock(t.token, dir);
    return true;
  }
  let exited = await waitForExit(o.timeoutMs ?? 10_000);
  if (!exited && (await signal('SIGKILL'))) exited = await waitForExit(2000);
  if (exited) releaseLock(t.token, dir);
  return exited;
}

export const PARENT_CHECK_INTERVAL_MS = 1000;

/**
 * The `--parent` rule: the core stays up while the parent **or** some registered client lives. When
 * the parent is gone and no client is left alive, calls `onGone` (once). Without `--parent`, nobody
 * watches: a core started by hand in the terminal only exits with `stop` or Ctrl-C.
 *
 * The parent is checked by pid. If it dies and the number is reused by another process before the
 * next round (one second), the core does not notice and stays up: the error is to stay, never to
 * exit for nothing nor to signal the new process. The same holds for registered clients.
 */
export function watchParent(o: { parent: number; dir?: string; intervalMs?: number; onGone: (reason: string) => void }): () => void {
  const dir = o.dir ?? defaultDir();
  let notified = false;
  const timer = setInterval(() => {
    if (isPidAlive(o.parent)) return;
    const alive = liveClients(dir);
    if (alive.length) return;
    if (notified) return;
    notified = true;
    clearInterval(timer);
    o.onGone(`o pai (pid ${o.parent}) sumiu e não há cliente registrado`);
  }, o.intervalMs ?? PARENT_CHECK_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
