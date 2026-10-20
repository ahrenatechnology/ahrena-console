// Mac collector (#175, decision 0008). Read-only, no `sudo`, with the commands that ship with macOS:
//
// | Group     | Source                                                                       |
// | --------- | ---------------------------------------------------------------------------- |
// | Memory    | `vm_stat` (used), `sysctl vm.swapusage`, `sysctl kern.memorystatus_vm_pressure_level` |
// | GPU       | `ioreg -r -d 1 -w 0 -c IOAccelerator` (utilization and memory in use)        |
// | Network   | `route -n get default` (the interface) and `netstat -ibn` (the bytes)        |
// | Processes | `ps -axo pid=,pcpu=,rss=,comm=` and `ps -axo pid=,uid=,etime=,args=`         |
// | Ports     | `lsof -nP -iTCP -sTCP:LISTEN` (only the user's processes, no `sudo`)         |
// | Tunnel    | the user's `ssh` processes with `-L` (or `-o LocalForward`) on the command line or `LocalForward` from `ssh -G <destination>`, and each port's probe |
//
// The OS name and version come from `sw_vers -productVersion`, once.

import type { GpuReading, ListeningPort, MemoryPressure, MemoryReading, TunnelPort, TunnelReading } from '../model.ts';
import {
  baseName,
  listenInterfaceOf,
  mergePorts,
  parsePsStats,
  parsePsUidArgs,
  PlatformCollector,
  type NetCounters,
  type ProcessSnapshot,
  type PsArgsRow,
} from './common.ts';

// ---------------------------------------------------------------------------------------------
// Memory

export function parseVmStat(out: string): { pageSize: number; pages: Record<string, number> } | null {
  const pageSize = Number(/page size of (\d+) bytes/.exec(out)?.[1]);
  if (!pageSize) return null;
  const pages: Record<string, number> = {};
  for (const m of out.matchAll(/^"?([^":\n]+)"?:\s+(\d+)\.?\s*$/gm)) pages[m[1].trim()] = Number(m[2]);
  return { pageSize, pages };
}

/**
 * Used memory as Activity Monitor counts it: app memory (anonymous minus purgeable), wired and
 * compressed. Without the anonymous pages (older macOS), the active ones.
 */
export function usedFromVmStat(vm: { pageSize: number; pages: Record<string, number> }): number | null {
  const p = vm.pages;
  const wired = p['Pages wired down'];
  const compressed = p['Pages occupied by compressor'] ?? 0;
  const apps = p['Anonymous pages'] !== undefined ? p['Anonymous pages'] - (p['Pages purgeable'] ?? 0) : p['Pages active'];
  if (wired === undefined || apps === undefined) return null;
  return (Math.max(0, apps) + wired + compressed) * vm.pageSize;
}

const SWAP_UNITS: Record<string, number> = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };

/** `vm.swapusage: total = 2048.00M  used = 819.25M  free = 1228.75M  (encrypted)`. */
export function parseSwapUsage(out: string): { totalBytes: number; usedBytes: number } | null {
  const v = (k: string) => {
    const m = new RegExp(`${k} = ([\\d.]+)([KMGT])`).exec(out);
    return m ? Math.round(Number(m[1]) * SWAP_UNITS[m[2]]) : null;
  };
  const totalBytes = v('total');
  const usedBytes = v('used');
  return totalBytes === null || usedBytes === null ? null : { totalBytes, usedBytes };
}

/** `kern.memorystatus_vm_pressure_level`: 1 normal, 2 warning, 4 critical. */
export function parsePressureLevel(out: string): MemoryPressure | null {
  return ({ '1': 'normal', '2': 'warning', '4': 'critical' } as const)[out.trim() as '1' | '2' | '4'] ?? null;
}

// ---------------------------------------------------------------------------------------------
// GPU

/** The first accelerator from `ioreg -c IOAccelerator`: name, utilization and the memory it uses. */
export function parseIoregGpu(out: string): GpuReading | null {
  const utilization = /"Device Utilization %"\s*=\s*(\d+)/.exec(out);
  if (!utilization) return null;
  const inUse = /"In use system memory"\s*=\s*(\d+)/.exec(out);
  return {
    name: /"model"\s*=\s*"([^"]+)"/.exec(out)?.[1] ?? null,
    usedPct: Number(utilization[1]),
    memoryUsedBytes: inUse ? Number(inUse[1]) : null,
    // Unified memory: there is no GPU total separate from the machine's.
    memoryTotalBytes: null,
  };
}

// ---------------------------------------------------------------------------------------------
// Network

/** `route -n get default` → the default route's interface. */
export function parseRouteDefault(out: string): string | null {
  return /^\s*interface:\s*(\S+)\s*$/m.exec(out)?.[1] ?? null;
}

/**
 * `netstat -ibn`, the interface's `<Link#n>` row: the last seven columns are Ipkts Ierrs Ibytes
 * Opkts Oerrs Obytes Coll (the address may be missing, so count from the end).
 */
export function parseNetstatIbn(out: string, iface: string): { rxBytes: number; txBytes: number } | null {
  for (const l of out.split('\n')) {
    const t = l.trim().split(/\s+/);
    if (t[0]?.replace(/\*$/, '') !== iface || !t[2]?.startsWith('<Link#') || t.length < 9) continue;
    const rx = Number(t.at(-5));
    const tx = Number(t.at(-2));
    if (Number.isFinite(rx) && Number.isFinite(tx)) return { rxBytes: rx, txBytes: tx };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Listening ports

/** `lsof -nP -iTCP -sTCP:LISTEN`: `COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME (LISTEN)`. */
export function parseLsofListen(out: string): ListeningPort[] {
  const ports: ListeningPort[] = [];
  for (const l of out.split('\n').slice(1)) {
    const t = l.trim().split(/\s+/);
    const i = t.indexOf('(LISTEN)');
    if (i < 2) continue;
    const name = t[i - 1];
    const sep = name.lastIndexOf(':');
    const port = Number(name.slice(sep + 1));
    if (sep < 0 || !Number.isInteger(port)) continue;
    ports.push({ port, ...listenInterfaceOf(name.slice(0, sep)), process: t[0].replace(/\\x20/g, ' '), pid: Number(t[1]) || null });
  }
  return mergePorts(ports);
}

// ---------------------------------------------------------------------------------------------
// Tunnel

export interface Forward {
  localPort: number;
  remoteHost: string;
  remotePort: number;
}

/** The `ssh` options that take an argument (man ssh). */
const OPTIONS_WITH_ARGUMENT = new Set('BbcDEeFIiJLlmOoPpQRSWw');

/** `[bind:]port:host:port`, with IPv6 in brackets. Unix sockets are left out. */
export function parseForwardSpec(spec: string): Forward | null {
  const m = /^(?:(?:\[[^\]]+\]|[^:[\]]*):)?(\d+):(\[[^\]]+\]|[^:[\]]+):(\d+)$/.exec(spec.trim());
  if (!m) return null;
  return { localPort: Number(m[1]), remoteHost: m[2].replace(/^\[|\]$/g, ''), remotePort: Number(m[3]) };
}

/**
 * The command line's `-o LocalForward`, as `[bind:]port:host:port`. `ps` loses the quotes, so
 * `-o "LocalForward 14720 127.0.0.1:4720"` arrives as three words: `value` is the first and `rest`
 * holds the following ones. Returns the spec and how many words of `rest` it consumed; `null` when
 * `value` is not a `LocalForward`.
 */
export function localForwardOption(value: string, rest: readonly string[]): { spec: string | null; consumed: number } | null {
  const m = /^localforward(?:\s*=\s*|\s+|$)(.*)$/i.exec(value);
  if (!m) return null;
  const parts = m[1].trim() ? m[1].trim().split(/\s+/) : [];
  let consumed = 0;
  // `LocalForward = 14720 …`: a lone `=` also arrives as a word.
  if (parts.length === 0 && rest[0] === '=') consumed++;
  while (parts.length < 2 && consumed < rest.length) parts.push(rest[consumed++]);
  return { spec: parts.length === 2 ? `${parts[0]}:${parts[1]}` : null, consumed };
}

export interface SshCommand {
  destination: string;
  forwards: Forward[];
  /** The command line's `-F`, so `ssh -G` reads the same file. */
  configFile: string | null;
}

/**
 * An `ssh` command line (from `ps`): the destination, the `-L`s and the `-F`. `null` when it is not
 * an `ssh` client (the ControlMaster master shows up as `ssh: <socket> [mux]`).
 */
export function parseSshArgs(args: string): SshCommand | null {
  const t = args.trim().split(/\s+/);
  if (baseName(t[0] ?? '') !== 'ssh') return null;
  const forwards: Forward[] = [];
  let configFile: string | null = null;
  for (let i = 1; i < t.length; i++) {
    const tok = t[i];
    // After `--`, a destination starting with `-` would become an option to `ssh -G`: it is left out.
    if (tok === '--') return t[i + 1] && !t[i + 1].startsWith('-') ? { destination: t[i + 1], forwards, configFile } : null;
    if (!tok.startsWith('-') || tok === '-') return { destination: tok, forwards, configFile };
    for (let j = 1; j < tok.length; j++) {
      const op = tok[j];
      if (!OPTIONS_WITH_ARGUMENT.has(op)) continue;
      const value = tok.length > j + 1 ? tok.slice(j + 1) : t[++i];
      if (value === undefined) return null;
      if (op === 'L') {
        const f = parseForwardSpec(value);
        if (f) forwards.push(f);
      }
      if (op === 'o') {
        const lf = localForwardOption(value, t.slice(i + 1));
        if (lf) {
          i += lf.consumed;
          const f = lf.spec ? parseForwardSpec(lf.spec) : null;
          if (f) forwards.push(f);
        }
      }
      if (op === 'F') configFile = value;
      break;
    }
  }
  return null;
}

/** `ssh -G <destination>`: the `localforward 14720 [127.0.0.1]:4720` lines (or `[localhost]:14720 …`). */
export function parseSshG(out: string): Forward[] {
  const fs: Forward[] = [];
  for (const m of out.matchAll(/^localforward\s+(?:\[[^\]]*\]:)?(\d+)\s+\[?([^\]\s]+?)\]?:(\d+)\s*$/gim)) {
    fs.push({ localPort: Number(m[1]), remoteHost: m[2], remotePort: Number(m[3]) });
  }
  return fs;
}

const since = (now: number, a: PsArgsRow) => (a.elapsedSec === null ? null : new Date(now - a.elapsedSec * 1000).toISOString());

// ---------------------------------------------------------------------------------------------

export class DarwinCollector extends PlatformCollector {
  protected readonly platform = 'darwin' as const;

  protected async readOsName(): Promise<string | null> {
    const v = (await this.run('sw_vers', ['-productVersion']))?.trim();
    return v ? `macOS ${v}` : null;
  }

  protected async memory(): Promise<MemoryReading> {
    const { os } = this.deps;
    const [vm, swap, pressureOut] = await Promise.all([
      this.run('vm_stat', []),
      this.run('sysctl', ['vm.swapusage']),
      this.run('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']),
    ]);
    const parsed = vm ? parseVmStat(vm) : null;
    const total = os.totalmem();
    const used = parsed ? usedFromVmStat(parsed) : null;
    const s = swap ? parseSwapUsage(swap) : null;
    return {
      totalBytes: total,
      usedBytes: Math.min(total, used ?? total - os.freemem()),
      swapTotalBytes: s?.totalBytes ?? null,
      swapUsedBytes: s?.usedBytes ?? null,
      pressure: pressureOut ? parsePressureLevel(pressureOut) : null,
    };
  }

  protected async gpu(): Promise<GpuReading | null> {
    const out = await this.run('ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator']);
    return out ? parseIoregGpu(out) : null;
  }

  protected async netCounters(): Promise<Omit<NetCounters, 'atMs'> | null> {
    const routeOut = await this.run('route', ['-n', 'get', 'default']);
    const iface = routeOut ? parseRouteDefault(routeOut) : null;
    if (!iface) return null;
    const out = await this.run('netstat', ['-ibn']);
    const c = out ? parseNetstatIbn(out, iface) : null;
    return c ? { interface: iface, ...c } : null;
  }

  protected async processes(): Promise<ProcessSnapshot | null> {
    const [stats, args] = await Promise.all([this.run('ps', ['-axo', 'pid=,pcpu=,rss=,comm=']), this.run('ps', ['-axo', 'pid=,uid=,etime=,args='])]);
    if (stats === null) return null;
    return { stats: parsePsStats(stats), args: args ? parsePsUidArgs(args) : [] };
  }

  protected async listeningPorts(): Promise<ListeningPort[] | null> {
    const out = await this.run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN']);
    return out === null ? null : parseLsofListen(out);
  }

  /**
   * Every `ssh` client of the user's own with forwarding: the command line's `-L`s or, without
   * them, the `LocalForward`s from `ssh -G`. Only the user's: `ps -ax` lists every account's, and
   * `ssh -G` runs, as us, the `Match exec` of the file it reads, so another account's `-F` (or a file
   * another account can write) would be that account's code running as us. An `-F` that fails this
   * check leaves the `ssh` without `ssh -G`. One `ssh -G` per file and destination, all at once. A
   * port belongs to the `ssh` that listens on it (two `ssh` to the same destination pick up the same
   * configuration, and only the first gets the port); the state:
   * - listened on by an `ssh` (this one, or the ControlMaster master): the probe says `up` or `idle`;
   * - listened on by another process: `busy`;
   * - nobody listens: `down`.
   */
  protected async tunnels(ps: ProcessSnapshot | null, ports: ListeningPort[] | null): Promise<TunnelReading[] | null> {
    if (!ps) return null;
    const now = this.now();
    const uid = this.deps.os.uid();
    if (uid === null) return null;
    const own: { row: PsArgsRow; cmd: SshCommand }[] = [];
    for (const row of ps.args) {
      if (row.uid !== uid) continue;
      const cmd = parseSshArgs(row.args);
      if (cmd) own.push({ row, cmd });
    }
    const keyOf = (cmd: SshCommand) => `${cmd.configFile ?? ''}\0${cmd.destination}`;
    const pending = new Map<string, Promise<Forward[]>>();
    for (const { cmd } of own) {
      if (cmd.forwards.length > 0 || pending.has(keyOf(cmd))) continue;
      pending.set(keyOf(cmd), this.sshG(cmd, uid));
    }
    const candidates: { row: PsArgsRow; cmd: SshCommand }[] = [];
    for (const { row, cmd } of own) {
      if (cmd.forwards.length === 0) cmd.forwards = await (pending.get(keyOf(cmd)) ?? Promise.resolve([]));
      if (cmd.forwards.length > 0) candidates.push({ row, cmd });
    }
    const listeners = new Map<number, ListeningPort>();
    for (const p of ports ?? []) if (!listeners.has(p.port) || p.process === 'ssh') listeners.set(p.port, p);
    const owner = new Map<number, number>();
    for (const { row, cmd } of candidates) {
      for (const f of cmd.forwards) {
        // Whoever listens on the port keeps it; otherwise, the first one asking for it.
        if (listeners.get(f.localPort)?.pid === row.pid) owner.set(f.localPort, row.pid);
        else if (!owner.has(f.localPort)) owner.set(f.localPort, row.pid);
      }
    }

    const tunnels: TunnelReading[] = [];
    for (const { row, cmd } of candidates) {
      const fs = cmd.forwards.filter((f) => owner.get(f.localPort) === row.pid);
      if (fs.length === 0) continue;
      const tunnelPorts = await Promise.all(fs.map((f) => this.tunnelPort(f, listeners.get(f.localPort) ?? null)));
      tunnels.push({ pid: row.pid, destination: cmd.destination, since: since(now, row), ports: tunnelPorts });
    }
    return tunnels;
  }

  /** The `LocalForward`s from `ssh -G`; `-F` is only passed when it is an absolute path of the user's that only they can write. */
  private async sshG(cmd: SshCommand, uid: number): Promise<Forward[]> {
    if (cmd.configFile !== null) {
      if (!cmd.configFile.startsWith('/')) return [];
      const owner = await this.deps.fileOwner(cmd.configFile).catch(() => null);
      if (!owner || owner.uid !== uid || (owner.mode & 0o022) !== 0) return [];
    }
    const g = await this.run('ssh', [...(cmd.configFile !== null ? ['-F', cmd.configFile] : []), '-G', '--', cmd.destination]);
    return g ? parseSshG(g) : [];
  }

  private async tunnelPort(f: Forward, holder: ListeningPort | null): Promise<TunnelPort> {
    const base = { localPort: f.localPort, remoteHost: f.remoteHost, remotePort: f.remotePort };
    // Without the port list (lsof failed), the probe decides on its own.
    if (holder && holder.process !== 'ssh') return { ...base, state: 'busy', heldBy: holder.process };
    const r = await this.deps.probe(f.localPort).catch(() => 'refused' as const);
    return { ...base, state: r === 'open' ? 'up' : r === 'closed' ? 'idle' : 'down', heldBy: null };
  }
}
