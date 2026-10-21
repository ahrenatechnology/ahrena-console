// The terminal side of "open the session" (#285): open a terminal resuming a session, and bring forward
// the terminal where its `claude` still runs. The route (session-open-route.ts) decides what to do;
// these only act, and every one is injected so the tests never open a terminal.
//
// No shell string is ever run: every program goes through `execFile`/`spawn` with an argument list.
//
// - macOS, open: a `.command` file in a folder only the núcleo reads (0700, file 0700, a unique name),
//   `#!/bin/sh`, the folder single-quoted (`cd -- '<cwd>' || exit 1`) and `exec claude --resume <id>`;
//   then `open <file>`, which runs it in whatever terminal the person has for `.command` files. The
//   file removes itself when it runs, and each call removes the leftovers older than an hour.
// - Linux, open: `x-terminal-emulator -e claude --resume <id>` in the folder, when it is on the PATH.
// - Anything else (Windows included: its folders are not POSIX paths): `unsupported`, and the route
//   answers 501 with the command to copy.
// - macOS, focus: `ps -o tty= -o lstart= -p <pid>` (in UTC, to compare with the `procStart` Claude Code
//   wrote: a recycled pid is not the session), the tty strictly `ttys<digits>`, then `osascript` with a
//   fixed script that takes `/dev/ttysNNN` as its only argument: Terminal.app's tabs first, then
//   iTerm2's sessions, each only when that app is already running.

import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, lstat, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { isUsableCwd, SESSION_ID_PATTERN, shellQuote, type LiveProcess } from './session-open.ts';

export interface TerminalRequest {
  sessionId: string;
  /** An absolute folder that exists; the route checks it. */
  cwd: string;
}

export type TerminalOpenResult = 'opened' | 'unsupported';
export type TerminalOpener = (r: TerminalRequest) => Promise<TerminalOpenResult>;
/**
 * Brings forward the terminal tab of a live process. `not-found`: the process is there but no tab of a
 * terminal it knows holds it (or this platform cannot tell). `stale`: the pid is gone or is another
 * process now (its start differs from `procStart`), so the session is not running after all.
 */
export type FocusResult = 'focused' | 'not-found' | 'stale';
export type TerminalFocuser = (p: LiveProcess) => Promise<FocusResult>;

/** How a program runs: always a file and a list of arguments. */
export interface ProcessRunner {
  /** Runs to the end and gives its stdout. */
  run(file: string, args: readonly string[], opts?: { env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<string>;
  /** Starts a program that outlives the request (a terminal window), detached. */
  spawnDetached(file: string, args: readonly string[], opts?: { cwd?: string }): Promise<void>;
}

export const systemRunner: ProcessRunner = {
  run: (file, args, opts = {}) =>
    new Promise((resolve, reject) =>
      execFile(file, [...args], { env: opts.env ?? process.env, timeout: opts.timeoutMs ?? 5_000, encoding: 'utf8' }, (err, stdout) => (err ? reject(err) : resolve(stdout))),
    ),
  spawnDetached: (file, args, opts = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn(file, [...args], { cwd: opts.cwd, detached: true, stdio: 'ignore' });
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    }),
};

/** The program on the PATH, or `null`. */
export async function findOnPath(name: string, path = process.env.PATH ?? ''): Promise<string | null> {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

/** The `.command` file that resumes a session; throws when the folder or the id cannot be carried. */
export function commandFileContent(cwd: string, sessionId: string): string {
  if (!isUsableCwd(cwd)) throw new Error('unusable folder');
  if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error('invalid session id');
  return ['#!/bin/sh', 'rm -f -- "$0"', `cd -- ${shellQuote(cwd)} || exit 1`, `exec claude --resume ${sessionId}`, ''].join('\n');
}

const COMMAND_FILE = /^resume-[0-9a-f-]{36}\.command$/;
const HOUR = 3_600_000;

export interface TerminalOpenerOptions {
  /** The folder the `.command` files go in (macOS); the núcleo owns it. */
  dir: string;
  platform?: NodeJS.Platform;
  runner?: ProcessRunner;
  findExecutable?: (name: string) => Promise<string | null>;
  now?: () => number;
  /** A leftover `.command` older than this is removed. Default an hour. */
  maxAgeMs?: number;
}

/** The private folder: created 0700, and refused when it is a link or not a folder. */
async function privateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const s = await lstat(dir);
  if (s.isSymbolicLink() || !s.isDirectory()) throw new Error('the resume folder is not a plain folder');
  await chmod(dir, 0o700);
}

async function removeOld(dir: string, now: number, maxAgeMs: number): Promise<void> {
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!COMMAND_FILE.test(name)) continue;
    const path = join(dir, name);
    try {
      if (now - (await lstat(path)).mtimeMs > maxAgeMs) await rm(path, { force: true });
    } catch {
      // gone already
    }
  }
}

export function createTerminalOpener({ dir, platform = process.platform, runner = systemRunner, findExecutable = findOnPath, now = Date.now, maxAgeMs = HOUR }: TerminalOpenerOptions): TerminalOpener {
  return async ({ sessionId, cwd }) => {
    if (platform === 'darwin') {
      const content = commandFileContent(cwd, sessionId);
      await privateDir(dir);
      await removeOld(dir, now(), maxAgeMs);
      const file = join(dir, `resume-${randomUUID()}.command`);
      await writeFile(file, content, { mode: 0o700, flag: 'wx' });
      await chmod(file, 0o700);
      await runner.run('open', [file]);
      return 'opened';
    }
    if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error('invalid session id');
    if (platform === 'linux') {
      const exe = await findExecutable('x-terminal-emulator');
      if (!exe) return 'unsupported';
      await runner.spawnDetached(exe, ['-e', 'claude', '--resume', sessionId], { cwd });
      return 'opened';
    }
    return 'unsupported';
  };
}

/** `ttys003` → `/dev/ttys003`; anything else (`??`, `../x`, `ttys3; x`) → `null`. */
export function ttyDevice(raw: string | null | undefined): string | null {
  return typeof raw === 'string' && /^ttys\d{1,5}$/.test(raw) ? `/dev/${raw}` : null;
}

/** `ps -o tty= -o lstart=`'s line: the tty and the start, whitespace collapsed. */
export function parsePsLine(out: string): { tty: string | null; start: string | null } {
  const m = /^\s*(\S+)\s+(.+?)\s*$/.exec(out.split('\n')[0] ?? '');
  return m ? { tty: m[1]!, start: m[2]!.replace(/\s+/g, ' ') } : { tty: null, start: null };
}

/** Terminal.app: the tab whose `tty` is the argument; only when Terminal is already running. */
export const TERMINAL_FOCUS_SCRIPT = `on run argv
  set targetTty to item 1 of argv
  if application id "com.apple.Terminal" is not running then return ""
  tell application id "com.apple.Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is targetTty then
          set selected tab of w to t
          set index of w to 1
          activate
          return "Terminal"
        end if
      end repeat
    end repeat
  end tell
  return ""
end run`;

/** iTerm2: the session whose `tty` is the argument; only when iTerm2 is already running. */
export const ITERM_FOCUS_SCRIPT = `on run argv
  set targetTty to item 1 of argv
  if application id "com.googlecode.iterm2" is not running then return ""
  tell application id "com.googlecode.iterm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if tty of s is targetTty then
            tell s to select
            tell t to select
            tell w to select
            activate
            return "iTerm2"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return ""
end run`;

export interface TerminalFocuserOptions {
  platform?: NodeJS.Platform;
  runner?: ProcessRunner;
}

export function createTerminalFocuser({ platform = process.platform, runner = systemRunner }: TerminalFocuserOptions = {}): TerminalFocuser {
  return async (proc) => {
    if (platform !== 'darwin' || !Number.isInteger(proc.pid) || proc.pid <= 0) return 'not-found';
    let line: string;
    try {
      line = await runner.run('ps', ['-o', 'tty=', '-o', 'lstart=', '-p', String(proc.pid)], { env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } });
    } catch (err) {
      // Only `ps -p` exiting with 1 says there is no such process. A timeout (`killed`, no code), a spawn
      // error (ENOENT, EAGAIN) or a signal says nothing about the session: it may still run, and resuming
      // it would start a second `claude` on the same transcript.
      return (err as { code?: unknown }).code === 1 ? 'stale' : 'not-found';
    }
    const { tty, start } = parsePsLine(line);
    if (!start) return 'stale';
    if (proc.procStart && start !== proc.procStart.replace(/\s+/g, ' ').trim()) return 'stale';
    const device = ttyDevice(tty);
    if (!device) return 'not-found';
    for (const script of [TERMINAL_FOCUS_SCRIPT, ITERM_FOCUS_SCRIPT]) {
      try {
        if ((await runner.run('osascript', ['-e', script, device], { timeoutMs: 10_000 })).trim()) return 'focused';
      } catch {
        // that app is missing or refused: try the next one
      }
    }
    return 'not-found';
  };
}
