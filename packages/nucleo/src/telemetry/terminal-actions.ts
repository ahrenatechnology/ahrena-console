// The actions on a terminal session (#350, decisions 0013 and 0014): the route sends ids (the terminal,
// the pid, the action), never a command. The núcleo reads the terminals again, checks that the pid is
// still the one the screen showed, in that same terminal, and the user's own, and only then signals.
//
// | Action      | Target                         | Signal  |
// | ----------- | ------------------------------ | ------- |
// | `interrupt` | the foreground process group   | SIGINT  |
// | `terminate` | the foreground process group   | SIGTERM |
// | `kill`      | the foreground process group   | SIGKILL (needs `confirm: true`, the screen's second confirmation) |
// | `hangup`    | the session: its `sshd`, or the shell without one | SIGHUP  |
// | `end`       | the same                       | SIGTERM |
//
// Never signaled: another user's processes, the `sshd` the console's own tunnel passes through, the
// núcleo and what runs it. On a remote machine, the Mac forwards only the ids, as a request with no
// `Origin`; the núcleo over there accepts it only when its config says so and does all the checking.

import type { RemoteWrite } from '../clouds/remote-connectors.ts';
import { LOCAL_MACHINE_ID } from './model.ts';
import type { TerminalProtection, TerminalsReading } from './model.ts';

export const TERMINAL_ACTIONS = {
  interrupt: { target: 'command', signal: 'SIGINT' },
  terminate: { target: 'command', signal: 'SIGTERM' },
  kill: { target: 'command', signal: 'SIGKILL' },
  hangup: { target: 'session', signal: 'SIGHUP' },
  end: { target: 'session', signal: 'SIGTERM' },
} as const;
export type TerminalActionId = keyof typeof TERMINAL_ACTIONS;
export const isTerminalAction = (s: string): s is TerminalActionId => Object.hasOwn(TERMINAL_ACTIONS, s);

export type TerminalActResult =
  | { kind: 'sent'; action: TerminalActionId; signal: NodeJS.Signals; pid: number; target: 'command' | 'session' }
  | { kind: 'unknown-machine' }
  | { kind: 'unknown-session' }
  | { kind: 'unreadable' }
  | { kind: 'changed' }
  | { kind: 'confirm-required' }
  | { kind: 'refused'; reason: TerminalProtection }
  | { kind: 'unreachable' }
  /** A remote núcleo's answer, projected: its status and the few fields the screen understands. */
  | { kind: 'relayed'; status: number; body: Record<string, unknown> };

export interface TerminalControl {
  act(machine: string, id: string, action: TerminalActionId, pid: number, confirm: boolean): Promise<TerminalActResult>;
  /** A loopback write with no `Origin` (the tunnel) passes only when this núcleo was started with `--accept-remote-actions`. */
  acceptNoOriginActions(): boolean;
}

export interface LocalTerminalOptions {
  /** The terminals now (the collector's). */
  read: () => Promise<TerminalsReading | null>;
  /** Sends the signal; a negative pid is a process group. Tests record it. */
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  /** After a signal: read again right away so the screen does not wait for the next 30 s sample. */
  onSignaled?: () => void;
  log?: (message: string) => void;
}

export class LocalTerminalActions {
  private readonly o: LocalTerminalOptions;

  constructor(options: LocalTerminalOptions) {
    this.o = options;
  }

  async act(id: string, action: TerminalActionId, pid: number, confirm: boolean): Promise<TerminalActResult> {
    const { target, signal } = TERMINAL_ACTIONS[action];
    if (action === 'kill' && !confirm) return { kind: 'confirm-required' };
    const reading = await this.o.read();
    if (!reading) return { kind: 'unreadable' };
    const session = reading.sessions.find((s) => s.id === id);
    if (!session) return { kind: 'unknown-session' };
    if (!session.own) return { kind: 'refused', reason: 'other-user' };

    let pidToSignal: number;
    let protection: TerminalProtection | null;
    if (target === 'command') {
      // Still the process the screen showed, still in the foreground of this terminal.
      if (!session.foreground || session.foreground.pid !== pid) return { kind: 'changed' };
      pidToSignal = -session.foreground.pgid;
      protection = session.foreground.protection;
    } else {
      if (session.end.pid === null || session.end.pid !== pid) return { kind: 'changed' };
      pidToSignal = session.end.pid;
      protection = session.end.protection;
    }
    if (protection) return { kind: 'refused', reason: protection };
    // `kill(0)` is the núcleo's own group and `kill(-1)` every process of the user: never a target.
    if (Math.abs(pidToSignal) <= 1) return { kind: 'changed' };
    try {
      (this.o.signal ?? process.kill)(pidToSignal, signal);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return { kind: 'changed' };
      // The group leader is another user's (a `sudo` the shell started): not ours to signal.
      if (code === 'EPERM') return { kind: 'refused', reason: 'other-user' };
      throw err;
    }
    this.o.log?.(`terminal ${session.tty}: ${action} (${signal}) on ${pidToSignal}`);
    this.o.onSignaled?.();
    return { kind: 'sent', action, signal, pid, target };
  }
}

const REASON = /^[a-z-]{1,40}$/;
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGHUP'];

/** What a remote núcleo's answer is allowed to carry back to the screen. */
export function relayBody(v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return {};
  const b = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof b.error === 'string') out.error = b.error.slice(0, 200);
  if (typeof b.reason === 'string' && REASON.test(b.reason)) out.reason = b.reason;
  if (b.result === 'sent') out.result = 'sent';
  if (typeof b.signal === 'string' && SIGNALS.includes(b.signal)) out.signal = b.signal;
  if (typeof b.target === 'string' && (b.target === 'command' || b.target === 'session')) out.target = b.target;
  return out;
}

export interface TerminalActionsOptions {
  local: LocalTerminalActions;
  remote?: { port: (machineId: string) => number | undefined; write: RemoteWrite } | null;
  acceptRemoteActions?: () => boolean;
  /** A remote action went through: read that machine again so the screen does not wait for the next poll. */
  onRemoteSent?: (machineId: string) => void;
}

export class TerminalActions implements TerminalControl {
  private readonly o: TerminalActionsOptions;

  constructor(options: TerminalActionsOptions) {
    this.o = options;
  }

  acceptNoOriginActions(): boolean {
    return this.o.acceptRemoteActions?.() ?? false;
  }

  async act(machine: string, id: string, action: TerminalActionId, pid: number, confirm: boolean): Promise<TerminalActResult> {
    if (machine === LOCAL_MACHINE_ID) return this.o.local.act(id, action, pid, confirm);
    const port = this.o.remote?.port(machine);
    if (port === undefined) return { kind: 'unknown-machine' };
    // Only the ids travel; the núcleo over there reads, checks and signals.
    const r = await this.o.remote!.write(port, 'POST', `/api/terminals/${id}/actions/${action}`, JSON.stringify({ pid, ...(confirm ? { confirm: true } : {}) }));
    if (r.kind === 'unreachable') return { kind: 'unreachable' };
    if (r.status === 200) this.o.onRemoteSent?.(machine);
    return { kind: 'relayed', status: [200, 403, 404, 409].includes(r.status) ? r.status : 502, body: relayBody(r.body) };
  }
}
