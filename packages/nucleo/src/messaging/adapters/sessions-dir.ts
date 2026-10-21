// `LiveSessions` over the configuration folders (#61): every live Claude Code process (Claude
// Desktop, terminal, `-p`) writes `$CLAUDE_CONFIG_DIR/sessions/<pid>.json`, and the file disappears
// when the process exits. The format is undocumented, so everything is read defensively.
//
// Only names matching `^\d+\.json$` are opened. The `<pid>.<hash>.key` next to each file holds the
// inbox token and is NEVER opened: on macOS and Linux the token is optional, the socket is already
// restricted to the user. A candidate counts only if:
//
// - the file is a regular file (not a symlink), of at most 64 KiB, with JSON whose `pid` is the
//   file name's and whose `sessionId` is the one asked;
// - the pid is alive and ours (`process.kill(pid, 0)`; `EPERM` is another user's process);
// - `messagingSocketPath` is an absolute, normalized path whose `lstat` is a socket (so not a
//   symlink) owned by the core's uid.
//
// `bridgeSessionId` (Remote Control on) is only tested for presence; its value is never kept.

import { lstat, readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';
import type { LiveProcess } from '../model.ts';
import type { LiveSessions } from '../ports.ts';

const SESSION_FILE = /^(\d{1,10})\.json$/;
const MAX_FILE_BYTES = 64 * 1024;
const ENTRYPOINT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface SessionsDirectoryOptions {
  /** The configuration folders to look in (the profiles), re-read on every call. */
  folders: () => Promise<readonly { dir: string }[]>;
  /** Whether the pid is a live process of this user. */
  isAlive?: (pid: number) => boolean;
  /** The core's uid; `null` skips the owner check (a platform without `getuid`). */
  uid?: number | null;
}

/** `process.kill(pid, 0)`: alive and signalable by us. `EPERM` is a process of another user: not ours. */
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

export class SessionsDirectory implements LiveSessions {
  private readonly folders: () => Promise<readonly { dir: string }[]>;
  private readonly isAlive: (pid: number) => boolean;
  private readonly uid: number | null;

  constructor({ folders, isAlive = processIsAlive, uid = typeof process.getuid === 'function' ? process.getuid() : null }: SessionsDirectoryOptions) {
    this.folders = folders;
    this.isAlive = isAlive;
    this.uid = uid;
  }

  async find(sessionId: string): Promise<LiveProcess[]> {
    const found: LiveProcess[] = [];
    for (const { dir } of await this.folders()) {
      const sessionsDir = join(dir, 'sessions');
      const names = await readdir(sessionsDir).catch(() => [] as string[]);
      for (const name of names.sort()) {
        const m = SESSION_FILE.exec(name);
        if (!m) continue;
        const p = await this.candidate(join(sessionsDir, name), Number(m[1]), dir, sessionId);
        if (p) found.push(p);
      }
    }
    return found;
  }

  private async candidate(file: string, pid: number, configDir: string, sessionId: string): Promise<LiveProcess | null> {
    try {
      const st = await lstat(file);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
      const o: unknown = JSON.parse(await readFile(file, 'utf8'));
      if (!isObj(o) || o.sessionId !== sessionId || o.pid !== pid || pid <= 0) return null;
      if (!this.isAlive(pid)) return null;
      const socketPath = o.messagingSocketPath;
      if (typeof socketPath !== 'string' || socketPath.includes('\0') || !isAbsolute(socketPath) || normalize(socketPath) !== socketPath) return null;
      const sock = await lstat(socketPath);
      if (!sock.isSocket()) return null;
      if (this.uid !== null && sock.uid !== this.uid) return null;
      const entrypoint = typeof o.entrypoint === 'string' && ENTRYPOINT.test(o.entrypoint) ? o.entrypoint : null;
      const remoteControl = typeof o.bridgeSessionId === 'string' && o.bridgeSessionId.length > 0;
      return { pid, socketPath, configDir, entrypoint, remoteControl };
    } catch {
      // Gone between readdir and read, half-written, not JSON, no socket: not a candidate.
      return null;
    }
  }
}
