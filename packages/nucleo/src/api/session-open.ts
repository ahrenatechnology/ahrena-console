import { isLegacyIdentity, type SessionIdentity } from '../identity.ts';
// Where a session opens (#285, wireframes C70 and C71): the `open` descriptor the Detail head, the wall
// cards, the Sessions rows and the Dashboard inbox items carry, and the resume command the screen's
// "Copiar comando" copies.
//
// | `target`        | When                                                                      | `command`   |
// | --------------- | ------------------------------------------------------------------------- | ----------- |
// | `desktop`       | The Claude Desktop index knows the session (a `local_…` id)                | `null`      |
// | `terminal-live` | No Desktop entry, and a live `claude` process for this session runs here  | resume line |
// | `terminal`      | No Desktop entry, no live process, and the session has a usable folder     | resume line |
// | `remote`        | The session runs on another machine (`machine` is set)                     | `null`      |
// | `none`          | Nothing can be opened: no usable folder, or an id that is not the UUID     | `null`      |
//
// The resume line is `cd '<cwd>' && claude --resume <id>`, built here from the session's own id and
// folder, never from screen text. The folder goes in single quotes (POSIX: each `'` inside becomes
// `'\''`), so `$(…)`, backticks, spaces and globs are literal; a folder with a line break or NUL is
// refused outright, and the id must be the UUID Claude Code gives its sessions. A remote machine's
// strings are never turned into a command here: a remote session has none.
//
// Pure: no disk, no process. The live processes come from a reader (live-processes.ts) the describer
// is given; without one, no session is live.

export const OPEN_TARGETS = ['desktop', 'terminal', 'terminal-live', 'remote', 'none'] as const;
export type OpenTarget = (typeof OPEN_TARGETS)[number];

/** The `open` field of every surface that describes a session. */
export interface SessionOpen {
  target: OpenTarget;
  /** The resume line for "Copiar comando" (`terminal` and `terminal-live`); `null` otherwise. */
  command: string | null;
}

/** The session id Claude Code writes: a UUID, nothing else. The only id a command or a route takes. */
export const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The Claude Desktop's `local_<uuid>` id. */
const DESKTOP_LOCAL_ID = /^local_[0-9a-f-]{36}$/;
const MAX_CWD = 4096;

/** A folder a shell line can carry: absolute, without NUL or a line break, not absurdly long. */
export function isUsableCwd(cwd: string | null | undefined): cwd is string {
  return typeof cwd === 'string' && cwd.startsWith('/') && cwd.length <= MAX_CWD && !/[\0\r\n]/.test(cwd);
}

/** POSIX single-quoting: the shell reads the result back as exactly `s`, with nothing expanded. */
export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** `cd '<cwd>' && claude --resume <id>`, or `null` when the folder or the id cannot be carried safely. */
export function resumeCommand(cwd: string | null | undefined, sessionId: string): string | null {
  if (!isUsableCwd(cwd) || !SESSION_ID_PATTERN.test(sessionId)) return null;
  return `cd ${shellQuote(cwd)} && claude --resume ${sessionId}`;
}

/** What decides the target: the session, the Desktop's id, the machine and whether a process runs here. */
export interface OpenFacts {
  identity?: SessionIdentity;
  sessionId: string;
  cwd: string | null;
  /** The Claude Desktop's `local_…`, when its index knows the session. */
  local: string | null;
  /** The remote machine the session runs on; `null` for this one. */
  machine: { id: string; label: string } | null;
  /** A live `claude` process for this session runs on this machine. */
  live: boolean;
}

export function describeOpen(f: OpenFacts): SessionOpen {
  if (f.identity && !isLegacyIdentity(f.identity)) return { target: 'none', command: null };
  if (f.sessionId.startsWith('session:')) return { target: 'none', command: null };
  if (f.machine) return { target: 'remote', command: null };
  if (f.local && DESKTOP_LOCAL_ID.test(f.local)) return { target: 'desktop', command: null };
  const command = resumeCommand(f.cwd, f.sessionId);
  if (!command) return { target: 'none', command: null };
  return { target: f.live ? 'terminal-live' : 'terminal', command };
}

/** A `claude` process of this machine (live-processes.ts), as the describer and the route see it. */
export interface LiveProcess {
  pid: number;
  sessionId: string;
  cwd: string | null;
  /** The process start Claude Code wrote, to tell a recycled pid apart; `null` when it wrote none. */
  procStart: string | null;
}

/** The live processes by session id; `refresh` respects the reader's own interval. */
export interface LiveProcessReader {
  refresh(): Promise<void>;
  find(sessionId: string): LiveProcess | null;
}

/** A session as a surface knows it, for `describe`. */
export interface OpenSubject {
  identity?: SessionIdentity;
  sessionId: string;
  cwd: string | null;
  local: string | null;
  machine?: { id: string; label: string } | null;
}

/** The descriptor with this machine's live processes; the surfaces call `refresh` once per build. */
export class SessionOpenDescriber {
  private readonly live: LiveProcessReader | null;

  constructor({ live = null }: { live?: LiveProcessReader | null } = {}) {
    this.live = live;
  }

  async refresh(): Promise<void> {
    await this.live?.refresh();
  }

  /** The live process of a session, when one runs here. */
  liveProcess(sessionId: string): LiveProcess | null {
    return this.live?.find(sessionId) ?? null;
  }

  describe(s: OpenSubject): SessionOpen {
    const machine = s.machine ?? null;
    const proc = machine ? null : this.liveProcess(s.sessionId);
    return describeOpen({ identity: s.identity, sessionId: s.sessionId, cwd: s.cwd ?? proc?.cwd ?? null, local: s.local, machine, live: proc !== null });
  }
}
