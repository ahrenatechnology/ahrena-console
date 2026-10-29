// Release a listening port (#286, decision 0016): stop the process that holds it.
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

export const REFUSAL_REASONS = ['unavailable', 'already-free', 'owner-changed', 'self', 'app', 'container', 'other-user', 'system', 'term-first'] as const;
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
/** How long a sent TERM counts as the first request that a KILL follows. */
const TERM_MEMORY_MS = 10 * 60_000;
const TERM_MEMORY_MAX = 256;

export interface PortReleaserDeps {
  /** The listeners now; `null` when they cannot be read. */
  listPorts(): Promise<ListeningPort[] | null>;
  run: CommandRunner;
  /** The uid running the núcleo; `null` where there is none (Windows): nothing is released. */
  uid(): number | null;
  /** This núcleo's pid and the pids above it, nearest first (the desktop app, a supervisor, `npm`). */
  selfPid: number;
  /** The pids above the núcleo, nearest first; `null` when a step cannot be read (nothing is released then). */
  ancestors(): Promise<number[] | null>;
  /** The clock, for how long a TERM stays on record (tests). */
  now?(): number;
  kill(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void;
  sleep?(ms: number): Promise<void>;
  /** Overrides the wait per signal (tests). */
  waitMs?: Partial<Record<ReleaseSignal, number>>;
}

export type PreviewResult =
  | { kind: 'ok'; process: string | null; pid: number; command: string; ports: number[]; interface: ListeningPort['interface'] }
  | Extract<ReleaseResult, { kind: 'refused' }>;

const COMMAND_MAX = 160;
/** Splits on whitespace outside quotes; a quoted value stays one token, quotes kept. */
function tokenize(line: string): string[] {
  return line.match(/(?:[^\s"']+|"[^"]*"?|'[^']*'?)+/g) ?? [];
}

const MASK = '***';
const PLAIN = /^[\w./@:+,-]{1,64}$/;
const BARE_FLAG = /^--?[A-Za-z][A-Za-z0-9-]{0,40}$/;
const SECRET_SHAPE = /^(?:ghp_|gho_|ghs_|ghu_|github_pat_|sk-|xox[abprs]-|AKIA|ASIA|eyJ)/;

/** A bare word that looks like a key more than a name: long, or letters and digits mixed with no path in it. */
function looksLikeSecret(t: string): boolean {
  return SECRET_SHAPE.test(t) || (t.length >= 20 && !t.includes('/') && /[A-Za-z]/.test(t) && /\d/.test(t)) || t.length > 40 && !t.includes('/');
}

/** A URL without its userinfo, query and fragment: where it points, nothing it carries. */
function plainUrl(t: string): string {
  const m = /^([a-z][a-z0-9+.-]*:\/\/)(?:[^/?#]*@)?([^/?#]*)([^?#]*)(\?|#)?/i.exec(t);
  return m ? `${m[1]}${m[2]}${m[3]}${m[4] ? `${m[4]}${MASK}` : ''}` : MASK;
}

/**
 * The command line as the confirmation shows it, by allow-list: the executable's name, bare flag
 * names, integers and plain words that are not values of a flag. Every value of a flag (`--x v`,
 * `--x=v`, `-xV`, `-Dname=v`, a flag with a dot in it), every `NAME=value`, every quoted string and
 * everything that looks like a key becomes `***`; URLs lose their userinfo and query. One line, short.
 */
export function summarizeCommand(command: string): string {
  const out: string[] = [];
  let afterFlag = false; // the next token is probably a flag's value
  let run = false; // a value was masked: plain words right after it are its continuation
  tokenize(command.replace(/[\u0000-\u001f\u007f]+/g, ' ')).forEach((t, i) => {
    if (i === 0) {
      const name = t.slice(t.lastIndexOf('/') + 1);
      out.push(/^[\w.+-]{1,64}$/.test(name) ? name : MASK);
      return;
    }
    if (t.startsWith('-') && t !== '-' && t !== '--') {
      afterFlag = true;
      const eq = t.indexOf('=');
      if (eq > 0) {
        const name = t.slice(0, eq);
        out.push(BARE_FLAG.test(name) ? `${name}=${MASK}` : `${name.startsWith('--') ? '--' : name.slice(0, 2)}${MASK}`);
        afterFlag = false;
        run = true;
      } else if (BARE_FLAG.test(t) && (t.startsWith('--') || t.length <= 4)) {
        out.push(t);
      } else {
        out.push(`${t.startsWith('--') ? '--' : t.slice(0, 2)}${MASK}`);
        afterFlag = t.startsWith('--');
        run = true;
      }
      return;
    }
    const value = afterFlag;
    afterFlag = false;
    if (/^\d{1,6}$/.test(t)) {
      out.push(t);
      return;
    }
    if (value) {
      out.push(MASK);
      run = true;
      return;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) out.push(`${t.slice(0, t.indexOf('='))}=${MASK}`);
    else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) {
      out.push(plainUrl(t));
      run = false;
    } else if (!PLAIN.test(t) || looksLikeSecret(t) || (t.includes(':') && t.includes('@'))) out.push(MASK);
    else if (run && !t.includes('/')) out.push(MASK);
    else {
      out.push(t);
      run = false;
    }
  });
  const clean = out.join(' ').trim();
  return clean.length > COMMAND_MAX ? `${clean.slice(0, COMMAND_MAX - 1)}…` : clean;
}

export class PortReleaser {
  private readonly d: PortReleaserDeps;

  /** `port:pid` of each TERM sent, with when: KILL is only accepted after one. */
  private readonly termSent = new Map<string, number>();

  constructor(deps: PortReleaserDeps) {
    this.d = deps;
  }

  /** Why the port cannot be released now, or who holds it. Nothing is sent. */
  private async check(port: number, pid: number): Promise<{ refusal: Extract<ReleaseResult, { kind: 'refused' }> } | { holder: ListeningPort; ports: ListeningPort[]; command: string }> {
    const refused = (reason: RefusalReason, now?: { process: string | null; pid: number | null } | null) => ({ refusal: { kind: 'refused' as const, reason, ...(now !== undefined ? { now } : {}) } });
    const ports = await this.d.listPorts();
    if (ports === null) return refused('unavailable');
    const holders = ports.filter((p) => p.port === port);
    if (holders.length === 0) return refused('already-free');
    const holder = holders.find((p) => p.pid === pid);
    if (!holder) {
      const other = holders[0]!;
      return refused('owner-changed', { process: other.process, pid: other.pid });
    }
    if (pid <= 1) return refused('system');
    if (pid === this.d.selfPid) return refused('self');
    const above = await this.d.ancestors();
    if (above === null) return refused('unavailable');
    if (holder.process !== null && CONTAINER_PROXIES.has(holder.process)) return refused('container');
    const uid = this.d.uid();
    if (uid === null) return refused('unavailable');
    const info = await this.processInfo(pid);
    if (info === null) return refused('already-free');
    if (APP_COMMAND.test(info.command)) return refused('app');
    if (above.includes(pid)) return refused('self');
    if (info.uid !== uid) return refused('other-user');
    return { holder, ports: ports.filter((p) => p.pid === pid), command: summarizeCommand(info.command) };
  }

  /** What the confirmation shows: the process, its short command and every port it holds; or why not. */
  async preview(port: number, pid: number): Promise<PreviewResult> {
    const c = await this.check(port, pid);
    if ('refusal' in c) return c.refusal;
    return { kind: 'ok', process: c.holder.process, pid, command: c.command, ports: c.ports.map((p) => p.port).sort((a, b) => a - b), interface: c.holder.interface };
  }

  async release(port: number, pid: number, signal: ReleaseSignal): Promise<ReleaseResult> {
    const c = await this.check(port, pid);
    if ('refusal' in c) return c.refusal;
    const key = `${port}:${pid}`;
    const now = this.d.now?.() ?? Date.now();
    if (signal === 'KILL' && now - (this.termSent.get(key) ?? -Infinity) > TERM_MEMORY_MS) return { kind: 'refused', reason: 'term-first' };
    try {
      this.d.kill(pid, signal === 'TERM' ? 'SIGTERM' : 'SIGKILL');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return { kind: 'released' };
      return { kind: 'refused', reason: code === 'EPERM' ? 'other-user' : 'unavailable' };
    }
    if (signal === 'TERM') this.rememberTerm(key, now);
    return (await this.closed(port, pid, this.d.waitMs?.[signal] ?? WAIT_MS[signal])) ? { kind: 'released' } : { kind: 'still-listening' };
  }

  private rememberTerm(key: string, now: number): void {
    this.termSent.delete(key);
    this.termSent.set(key, now);
    for (const old of this.termSent.keys()) {
      if (this.termSent.size <= TERM_MEMORY_MAX) break;
      this.termSent.delete(old);
    }
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

/**
 * The pids above the núcleo, nearest first: its parent (`ppid`, from the process itself) and then
 * each parent read with `ps -o ppid=` up to pid 1 or a loop. A step that cannot be read before that
 * is `null`: a chain cut short must not let an ancestor be signalled. A complete chain is kept.
 */
export function ancestorsWith(run: CommandRunner, ppid: number): () => Promise<number[] | null> {
  let known: number[] | null = null;
  return async () => {
    if (known) return known;
    const chain: number[] = [];
    let at = ppid;
    for (let hops = 0; at > 1 && hops < 32; hops++) {
      if (chain.includes(at)) break;
      chain.push(at);
      const out = await run('ps', ['-o', 'ppid=', '-p', String(at)]);
      const parent = out === null ? NaN : Number.parseInt(out.trim(), 10);
      if (!Number.isInteger(parent) || parent < 0) return null;
      at = parent;
    }
    known = chain;
    return chain;
  };
}
