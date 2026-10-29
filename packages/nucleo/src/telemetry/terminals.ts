// Terminal sessions (#350): one row per pseudo-terminal, from `ps` and, on Linux, `ss`.
//
// | Platform | Command                                                                                  |
// | -------- | ---------------------------------------------------------------------------------------- |
// | Linux    | `ps -eo pid=,ppid=,pgid=,tpgid=,tty=,stat=,etimes=,uid=,user=,args=`; `ss -tnp` (the tunnel) |
// | macOS    | `ps -axo pid=,ppid=,pgid=,tpgid=,tty=,stat=,etime=,uid=,user=,command=`                  |
//
// A terminal's foreground group is the one whose id is the terminal's `tpgid`. Only the idle prompt
// has an interactive shell as the leader of that group; anything else there is "the command".
// Every function is pure and takes the command output as text (tests run over recorded outputs).

import type { TerminalProtection, TerminalSession, TerminalsReading } from './model.ts';

/** A foreground command older than this, and not a known interactive one, is "presa" (#350). */
export const STUCK_AFTER_SEC = 15 * 60;
/** A Claude scratchpad script is held to a shorter leash: it should end by itself. */
export const SCRATCHPAD_STUCK_AFTER_SEC = 2 * 60;
const MAX_ARGS = 300;

export const LINUX_TERMINALS_PS = ['-eo', 'pid=,ppid=,pgid=,tpgid=,tty=,stat=,etimes=,uid=,user=,args='] as const;
export const DARWIN_TERMINALS_PS = ['-axo', 'pid=,ppid=,pgid=,tpgid=,tty=,stat=,etime=,uid=,user=,command='] as const;

/** Commands that wait for the person on purpose; the config's `terminal.interactiveCommands` adds to them. */
export const INTERACTIVE_COMMANDS: readonly string[] = ['vim', 'vi', 'nvim', 'nano', 'emacs', 'less', 'more', 'man', 'top', 'htop', 'btop', 'watch', 'tmux', 'screen', 'ssh', 'mosh', 'claude', 'sudo', 'su', 'psql', 'mysql', 'sqlite3'];
const SHELLS = new Set(['bash', 'zsh', 'sh', 'dash', 'fish', 'ksh', 'tcsh', 'csh']);
const TERMINAL_APPS = /(Terminal|iTerm2?|Ghostty|WezTerm|Alacritty|kitty|Warp|tmux)/;
const SSHD_SESSION = /^sshd: (\S+?)@(\S+)/;
const SCRATCHPAD = /\/claude-\d+\/[^/\s]+\/([0-9a-f]{8}-[0-9a-f-]{27})\/scratchpad\//;
const SCRATCHPAD_ANY = /\/claude-\d+\/.+\/scratchpad\//;

export interface PsRow {
  pid: number;
  ppid: number;
  pgid: number;
  tpgid: number;
  tty: string;
  stat: string;
  etimeSec: number;
  uid: number;
  user: string;
  args: string;
}

/** `etimes` (seconds) on Linux, `etime` (`[[dd-]hh:]mm:ss`) on the Mac. */
export function parseElapsed(s: string): number | null {
  if (/^\d+$/.test(s)) return Number(s);
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(s);
  if (!m) return null;
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4]);
}

/** A command line can carry a secret: URL credentials, `--token x`, `password=x`, `Bearer x`, `-pSECRET`. Masked before it is kept. */
export function maskSecrets(args: string): string {
  return args
    .replace(/(\w+:\/\/)[^\s/@]*:[^\s/@]*@/g, '$1***@')
    .replace(/(--[\w-]*(?:pass(?:word)?|token|secret|key|auth)[\w-]*[= ])\S+/gi, '$1***')
    .replace(/\b((?:pass(?:word)?|token|secret|api[_-]?key)=)\S+/gi, '$1***')
    .replace(/\b(Bearer|Basic)\s+\S+/g, '$1 ***')
    .replace(/(\s-p)\S+/g, '$1***');
}

export function parseTerminalsPs(out: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const etimeSec = parseElapsed(m[7]!);
    if (etimeSec === null) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), tpgid: Number(m[4]), tty: m[5]!, stat: m[6]!, etimeSec, uid: Number(m[8]), user: m[9]!, args: maskSecrets(m[10]!.trim()).slice(0, MAX_ARGS) });
  }
  return rows;
}

/**
 * `ss -tnp`: the `sshd` processes holding an established connection to the núcleo's own port. That is
 * the connection the tunnel of the console passes through; its sessions must never be closed from here.
 */
export function parseTunnelSshd(out: string, corePort: number): Set<number> {
  const pids = new Set<number>();
  for (const l of out.split('\n')) {
    const t = l.trim().split(/\s+/);
    if (t[0] !== 'ESTAB' || t.length < 5) continue;
    const peer = t[4]!;
    if (Number(peer.slice(peer.lastIndexOf(':') + 1)) !== corePort) continue;
    for (const m of t.slice(5).join(' ').matchAll(/\("sshd",pid=(\d+)/g)) pids.add(Number(m[1]));
  }
  return pids;
}

const ttyId = (tty: string) => tty.replace('/', '-');
export const TERMINAL_ID = /^(?:pts-\d{1,6}|ttys\d{1,4})$/;
const isTerminalTty = (tty: string) => /^(?:pts\/\d+|ttys\d+)$/.test(tty);
const basename = (s: string) => s.slice(s.lastIndexOf('/') + 1);

/** `bash -l`, `-zsh`, `zsh`: a shell with no script or `-c` command to run. */
export function isInteractiveShell(args: string): boolean {
  const [argv0 = '', ...rest] = args.split(/\s+/);
  const name = basename(argv0).replace(/^-/, '');
  return SHELLS.has(name) && rest.every((a) => a.startsWith('-') && a !== '-c');
}

function commandName(args: string): string {
  return basename(args.split(/\s+/)[0] ?? '').replace(/^-/, '');
}

export interface BuildTerminalsOptions {
  nowMs: number;
  /** The uid running the núcleo; only its sessions are `own`. */
  uid: number | null;
  /** The núcleo's pid: it and everything that runs it are protected. */
  selfPid: number;
  tunnelSshd?: ReadonlySet<number>;
  interactive?: readonly string[];
  /** `terminal.acceptRemoteActions` of this núcleo, told to the screen that reads it from the Mac. */
  remoteActions?: boolean;
  stuckAfterSec?: number;
}

/** The terminal sessions of a `ps` reading. */
export function buildTerminals(rows: readonly PsRow[], o: BuildTerminalsOptions): TerminalsReading {
  const stuckAfterSec = o.stuckAfterSec ?? STUCK_AFTER_SEC;
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const core = new Set<number>();
  for (let p = byPid.get(o.selfPid); p && !core.has(p.pid) && core.size < 64; p = byPid.get(p.ppid)) core.add(p.pid);
  core.add(o.selfPid);
  const interactive = new Set([...INTERACTIVE_COMMANDS, ...(o.interactive ?? [])]);

  const byTty = new Map<string, PsRow[]>();
  for (const r of rows) if (isTerminalTty(r.tty)) byTty.set(r.tty, [...(byTty.get(r.tty) ?? []), r]);

  const sessions: TerminalSession[] = [];
  for (const [tty, group] of [...byTty].sort((a, b) => a[0].localeCompare(b[0], 'en', { numeric: true }))) {
    const pids = new Set(group.map((r) => r.pid));
    const tpgid = group[0]!.tpgid;
    const fgRows = group.filter((r) => r.pgid === tpgid);
    const leader = fgRows.find((r) => r.pid === tpgid) ?? [...fgRows].sort((a, b) => a.pid - b.pid)[0] ?? null;
    const idle = leader === null || isInteractiveShell(leader.args);
    const top = [...group].filter((r) => !pids.has(r.ppid)).sort((a, b) => a.pid - b.pid)[0] ?? group[0]!;
    const shellRow = idle ? (leader ?? top) : (group.filter((r) => isInteractiveShell(r.args) && !fgRows.includes(r)).sort((a, b) => a.pid - b.pid)[0] ?? null);
    const user = (shellRow ?? top).user;
    const own = o.uid !== null && (shellRow ?? top).uid === o.uid;

    // The connection: the nearest `sshd: user@pts/N` ancestor of the shell, else a terminal app, else none.
    let conn: TerminalSession['connection'] = { kind: 'local', pid: null, label: null, since: null, ttys: [tty], protection: null };
    const seen = new Set<number>();
    for (let p = byPid.get((shellRow ?? top).ppid); p && !seen.has(p.pid) && seen.size < 12; p = byPid.get(p.ppid)) {
      seen.add(p.pid);
      const ssh = SSHD_SESSION.exec(p.args);
      if (ssh) {
        conn = { kind: 'sshd', pid: p.pid, label: ssh[1]!, since: new Date(o.nowMs - p.etimeSec * 1000).toISOString(), ttys: ssh[2]!.split(','), protection: null };
        break;
      }
      const app = TERMINAL_APPS.exec(p.args);
      if (app && conn.kind === 'local') conn = { kind: 'app', pid: null, label: app[1]!, since: new Date(o.nowMs - p.etimeSec * 1000).toISOString(), ttys: [tty], protection: null };
    }
    const protect = (pid: number | null, members: Iterable<number>): TerminalProtection | null => {
      if (!own) return 'other-user';
      if (pid !== null && o.tunnelSshd?.has(pid)) return 'tunnel';
      for (const m of members) if (core.has(m)) return 'core';
      return null;
    };
    conn.protection = conn.pid !== null ? protect(conn.pid, [conn.pid]) : null;

    const stopped = leader !== null && !idle && leader.stat.startsWith('T');
    const state = idle ? 'idle' : stopped ? 'stopped' : 'running';
    const fg = idle || leader === null ? null : { pid: leader.pid, pgid: leader.pgid, args: leader.args, ageSec: leader.etimeSec, processes: fgRows.length, protection: protect(null, fgRows.map((r) => r.pid)) };
    const endPid = conn.kind === 'sshd' ? conn.pid : (shellRow?.pid ?? null);
    const end = { pid: endPid, protection: conn.kind === 'sshd' ? conn.protection : protect(endPid, endPid === null ? [] : [endPid]) };

    const scratchpad = fg ? SCRATCHPAD_ANY.test(fg.args) || group.some((r) => r.pgid === tpgid && SCRATCHPAD_ANY.test(r.args)) : false;
    const known = fg ? interactive.has(commandName(fg.args)) : false;
    const stuck = fg !== null && own && state === 'running' && fg.protection !== 'core' && !known && (fg.ageSec >= stuckAfterSec || (scratchpad && fg.ageSec >= SCRATCHPAD_STUCK_AFTER_SEC));

    sessions.push({
      tty,
      id: ttyId(tty),
      user,
      own,
      connection: conn,
      shell: shellRow ? { pid: shellRow.pid, args: shellRow.args } : null,
      foreground: fg,
      end,
      state,
      stuck,
      claudeSessionId: fg ? (SCRATCHPAD.exec(fg.args)?.[1] ?? fgRows.map((r) => SCRATCHPAD.exec(r.args)?.[1]).find(Boolean) ?? null) : null,
    });
  }
  return { sessions, stuckAfterSec, remoteActions: o.remoteActions ?? false };
}

// ---------------------------------------------------------------------------------------------
// A remote núcleo's terminals, as this Mac reads them: projected field by field, capped.

const MAX_REMOTE_SESSIONS = 64;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length <= max ? v : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 2 ** 31 ? v : null);
const PROTECTIONS = ['tunnel', 'core', 'other-user'] as const;
const protectionOf = (v: unknown): TerminalProtection | null => (PROTECTIONS as readonly unknown[]).includes(v) ? (v as TerminalProtection) : null;

/** `null` when it is not a terminals reading; a session that does not have the shape is left out. */
export function sanitizeTerminals(v: unknown): TerminalsReading | null {
  if (!isObj(v) || !Array.isArray(v.sessions)) return null;
  const stuckAfterSec = int(v.stuckAfterSec) ?? STUCK_AFTER_SEC;
  const sessions: TerminalSession[] = [];
  for (const s of v.sessions.slice(0, MAX_REMOTE_SESSIONS)) {
    if (!isObj(s) || !isObj(s.connection) || !isObj(s.end)) continue;
    const tty = str(s.tty, 16);
    const id = str(s.id, 16);
    const user = str(s.user, 64);
    const c = s.connection;
    const kind = c.kind === 'sshd' || c.kind === 'app' || c.kind === 'local' ? c.kind : null;
    if (!tty || !id || !TERMINAL_ID.test(id) || !isTerminalTty(tty) || !user || !kind || (s.state !== 'idle' && s.state !== 'running' && s.state !== 'stopped')) continue;
    const fg = isObj(s.foreground) ? s.foreground : null;
    const foreground = fg && int(fg.pid) !== null && int(fg.pgid) !== null && str(fg.args, MAX_ARGS) !== null && int(fg.ageSec) !== null && int(fg.processes) !== null
      ? { pid: int(fg.pid)!, pgid: int(fg.pgid)!, args: str(fg.args, MAX_ARGS)!, ageSec: int(fg.ageSec)!, processes: int(fg.processes)!, protection: protectionOf(fg.protection) }
      : null;
    const sh = isObj(s.shell) ? s.shell : null;
    sessions.push({
      tty,
      id,
      user,
      own: s.own === true,
      connection: {
        kind,
        pid: int(c.pid),
        label: str(c.label, 64),
        since: str(c.since, 40),
        ttys: Array.isArray(c.ttys) ? c.ttys.slice(0, 16).flatMap((t) => (typeof t === 'string' && isTerminalTty(t) ? [t] : [])) : [],
        protection: protectionOf(c.protection),
      },
      shell: sh && int(sh.pid) !== null && str(sh.args, MAX_ARGS) !== null ? { pid: int(sh.pid)!, args: str(sh.args, MAX_ARGS)! } : null,
      foreground,
      end: { pid: int(s.end.pid), protection: protectionOf(s.end.protection) },
      state: s.state,
      stuck: s.stuck === true && foreground !== null,
      claudeSessionId: typeof s.claudeSessionId === 'string' && /^[0-9a-f-]{36}$/.test(s.claudeSessionId) ? s.claudeSessionId : null,
    });
  }
  return { sessions, stuckAfterSec, remoteActions: v.remoteActions === true };
}
