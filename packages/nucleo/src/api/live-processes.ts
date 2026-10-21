// The `claude` processes running on this machine (#285): Claude Code writes `<config>/sessions/<pid>.json`
// for each live process (`pid`, `sessionId`, `cwd`, `procStart`…), in every configuration folder the
// person uses (decision 0006: `~/.claude`, the `~/.claude-*` ones, those of perfis.json and those the
// hooks reveal). A file can outlive its process, so a session is live only while its pid answers
// `kill(pid, 0)`; the route also compares `procStart` before acting on a pid (terminal-launch.ts).
//
// Cost: the folders are listed at most every `intervalMs` (5 s); each file is read only when its
// mtime changes. Only the fields below are kept; the rest of the JSON is ignored.

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { SESSION_ID_PATTERN, type LiveProcess, type LiveProcessReader } from './session-open.ts';

export interface LiveProcessesOptions {
  /** The configuration folders (`Profiles.list()` → `dir`). */
  folders: () => Promise<readonly string[]> | readonly string[];
  /** Whether the pid is alive; default `process.kill(pid, 0)`. */
  isAlive?: (pid: number) => boolean;
  /** Minimum time between two disk checks. Default 5 s. */
  intervalMs?: number;
  now?: () => number;
}

/** `kill(pid, 0)`: alive when it succeeds, or when the pid exists but belongs to someone else. */
export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const PID_FILE = /^([1-9][0-9]{0,9})\.json$/;
const MAX_FILES = 2_000;
const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);

async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/** The live processes by session id; see the top of the file. */
export class LiveClaudeProcesses implements LiveProcessReader {
  private readonly folders: LiveProcessesOptions['folders'];
  private readonly isAlive: (pid: number) => boolean;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly files = new Map<string, { mtimeMs: number; proc: LiveProcess | null }>();
  private bySession = new Map<string, LiveProcess[]>();
  private checkedAt = -Infinity;
  private pending: Promise<void> | null = null;

  constructor({ folders, isAlive = pidIsAlive, intervalMs = 5_000, now = Date.now }: LiveProcessesOptions) {
    this.folders = folders;
    this.isAlive = isAlive;
    this.intervalMs = intervalMs;
    this.now = now;
  }

  async refresh(force = false): Promise<void> {
    if (!force && this.now() - this.checkedAt < this.intervalMs) return;
    this.pending ??= this.scan().finally(() => {
      this.checkedAt = this.now();
      this.pending = null;
    });
    return this.pending;
  }

  /** The session's process, only while its pid is alive; the newest file wins when several name it. */
  find(sessionId: string): LiveProcess | null {
    for (const p of this.bySession.get(sessionId) ?? []) if (this.isAlive(p.pid)) return p;
    return null;
  }

  private async scan(): Promise<void> {
    const seen = new Set<string>();
    const dirs = [...new Set(await this.folders())].map((d) => join(d, 'sessions'));
    for (const dir of dirs) {
      for (const name of (await listDir(dir)).slice(0, MAX_FILES)) {
        const m = PID_FILE.exec(name);
        if (!m) continue;
        const path = join(dir, name);
        let mtimeMs: number;
        try {
          mtimeMs = (await stat(path)).mtimeMs;
        } catch {
          continue;
        }
        seen.add(path);
        if (this.files.get(path)?.mtimeMs === mtimeMs) continue;
        this.files.set(path, { mtimeMs, proc: await read(path, Number(m[1])) });
      }
    }
    for (const path of [...this.files.keys()]) if (!seen.has(path)) this.files.delete(path);
    const bySession = new Map<string, { mtimeMs: number; proc: LiveProcess }[]>();
    for (const { mtimeMs, proc } of this.files.values()) {
      if (proc) bySession.set(proc.sessionId, [...(bySession.get(proc.sessionId) ?? []), { mtimeMs, proc }]);
    }
    this.bySession = new Map([...bySession].map(([id, list]) => [id, list.sort((a, b) => b.mtimeMs - a.mtimeMs).map((x) => x.proc)]));
  }
}

/** One `<pid>.json`: the pid in the name must be the one inside, and the session id the UUID. */
async function read(path: string, pidFromName: number): Promise<LiveProcess | null> {
  try {
    const o = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    const sessionId = str(o.sessionId, 64);
    if (o.pid !== pidFromName || !sessionId || !SESSION_ID_PATTERN.test(sessionId)) return null;
    return { pid: pidFromName, sessionId, cwd: str(o.cwd, 4096), procStart: str(o.procStart, 64) };
  } catch {
    return null;
  }
}
