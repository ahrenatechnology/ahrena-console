// Release a listening port (#286, decision 0015): stop the process that holds it.
//
// The caller names a port and the pid it saw; nothing else. The núcleo reads the listeners again
// and acts only when that pid still owns that port, and only on a process of the user running the
// núcleo: never itself, never the desktop app, never a container's `docker-proxy` (the stack is the
// owner, #288), never anything that would need a password. SIGTERM first; SIGKILL is a second
// request the screen makes after its own second confirmation. No command is built from the request
// and no shell is involved: the signal goes through `process.kill`.

import type { ListeningPort } from '../telemetry/model.ts';
import type { CommandRunner } from '../telemetry/ports.ts';
import { parseLsofListen } from '../telemetry/adapters/darwin.ts';
import { parseSs } from '../telemetry/adapters/linux.ts';

export const RELEASE_SIGNALS = ['TERM', 'KILL'] as const;
export type ReleaseSignal = (typeof RELEASE_SIGNALS)[number];

export const REFUSAL_REASONS = ['unavailable', 'already-free', 'owner-changed', 'self', 'app', 'container', 'other-user'] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

export type ReleaseResult =
  | { kind: 'released' }
  | { kind: 'still-listening' }
  | { kind: 'refused'; reason: RefusalReason; now?: { process: string | null; pid: number | null } | null };

/** Processes that publish a container's port: the stack is the owner, not the proxy. */
const CONTAINER_PROXIES = new Set(['docker-proxy', 'rootlessport', 'com.docker.backend', 'gvproxy', 'vpnkit-bridge']);
/** The desktop app's bundle (`Ahrena Console.app/...`), as `ps` shows its command. */
const APP_COMMAND = /Ahrena Console\.app\//;
/** How long each signal waits for the port to close. */
const WAIT_MS: Record<ReleaseSignal, number> = { TERM: 5_000, KILL: 3_000 };
const POLL_MS = 250;

export interface PortReleaserDeps {
  /** The listeners now; `null` when they cannot be read. */
  listPorts(): Promise<ListeningPort[] | null>;
  run: CommandRunner;
  /** The uid running the núcleo; `null` where there is none (Windows): nothing is released. */
  uid(): number | null;
  /** This núcleo's pid and its parent's (the desktop app starts it). */
  selfPid: number;
  parentPid: number;
  kill(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void;
  sleep?(ms: number): Promise<void>;
  /** Overrides the wait per signal (tests). */
  waitMs?: Partial<Record<ReleaseSignal, number>>;
}

export class PortReleaser {
  private readonly d: PortReleaserDeps;

  constructor(deps: PortReleaserDeps) {
    this.d = deps;
  }

  async release(port: number, pid: number, signal: ReleaseSignal): Promise<ReleaseResult> {
    const refused = (reason: RefusalReason, now?: { process: string | null; pid: number | null } | null): ReleaseResult => ({ kind: 'refused', reason, ...(now !== undefined ? { now } : {}) });
    const ports = await this.d.listPorts();
    if (ports === null) return refused('unavailable');
    const holders = ports.filter((p) => p.port === port);
    if (holders.length === 0) return refused('already-free');
    const holder = holders.find((p) => p.pid === pid);
    if (!holder) {
      const other = holders[0]!;
      return refused('owner-changed', { process: other.process, pid: other.pid });
    }
    if (pid === this.d.selfPid || pid === this.d.parentPid || pid <= 1) return refused(pid === this.d.parentPid ? 'app' : 'self');
    if (holder.process !== null && CONTAINER_PROXIES.has(holder.process)) return refused('container');
    const uid = this.d.uid();
    if (uid === null) return refused('unavailable');
    const info = await this.processInfo(pid);
    if (info === null) return refused('already-free');
    if (APP_COMMAND.test(info.command)) return refused('app');
    if (info.uid !== uid) return refused('other-user');
    try {
      this.d.kill(pid, signal === 'TERM' ? 'SIGTERM' : 'SIGKILL');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return { kind: 'released' };
      return refused(code === 'EPERM' ? 'other-user' : 'unavailable');
    }
    return (await this.closed(port, pid, this.d.waitMs?.[signal] ?? WAIT_MS[signal])) ? { kind: 'released' } : { kind: 'still-listening' };
  }

  private async processInfo(pid: number): Promise<{ uid: number; command: string } | null> {
    const out = await this.d.run('ps', ['-o', 'uid=,args=', '-p', String(pid)]);
    const m = out ? /^\s*(\d+)\s+(.*)$/m.exec(out) : null;
    return m ? { uid: Number(m[1]), command: m[2]! } : null;
  }

  private async closed(port: number, pid: number, waitMs: number): Promise<boolean> {
    const sleep = this.d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let waited = 0; ; waited += POLL_MS) {
      const ports = await this.d.listPorts();
      if (ports !== null && !ports.some((p) => p.port === port && p.pid === pid)) return true;
      if (waited >= waitMs) return false;
      await sleep(POLL_MS);
    }
  }
}

/** The listeners of this platform, read the way the telemetry collectors read them. */
export function listPortsWith(run: CommandRunner, platform: NodeJS.Platform = process.platform): () => Promise<ListeningPort[] | null> {
  return async () => {
    if (platform === 'darwin') {
      const out = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN']);
      return out === null ? null : parseLsofListen(out);
    }
    if (platform === 'linux') {
      const out = await run('ss', ['-ltnp']);
      return out === null ? null : parseSs(out);
    }
    return null;
  };
}
