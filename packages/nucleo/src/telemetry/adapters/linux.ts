// Linux collector (#175, decision 0008): the remote machine running its own núcleo. Read-only, no
// `sudo`, with `/proc` and the commands that already ship with the system:
//
// | Group     | Source                                                                   |
// | --------- | ------------------------------------------------------------------------ |
// | Memory    | `/proc/meminfo` (used = total − available; swap)                         |
// | GPU       | `nvidia-smi --query-gpu=…` when present; otherwise absent                |
// | Network   | `/proc/net/route` (the default route's interface) and `/proc/net/dev`    |
// | Processes | `ps -eo pid=,pcpu=,rss=,comm=` and `ps -eo pid=,etime=,args=`            |
// | Ports     | `ss -ltnp` (the process only shows for the user's own)                   |
// | Tunnel    | does not apply: `tunnels` comes out `null`                               |
//
// The OS name comes from `PRETTY_NAME` in `/etc/os-release`, once.

import type { GpuReading, ListeningPort, MemoryReading, TunnelReading } from '../model.ts';
import { listenInterfaceOf, mergePorts, parsePsArgs, parsePsStats, PlatformCollector, type NetCounters, type ProcessSnapshot } from './common.ts';

/** `/proc/meminfo` → the fields in bytes (the file says kB). */
export function parseMeminfo(out: string): Record<string, number> {
  const fields: Record<string, number> = {};
  for (const m of out.matchAll(/^(\w+(?:\(\w+\))?):\s+(\d+)(?:\s+kB)?\s*$/gm)) fields[m[1]] = Number(m[2]) * 1024;
  return fields;
}

/** `nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits`, the first card. */
export function parseNvidiaSmi(out: string): GpuReading | null {
  const line = out.split('\n').find((l) => l.trim());
  if (!line) return null;
  const [name, utilization, used, total] = line.split(',').map((s) => s.trim());
  const toNumber = (s: string | undefined) => (s !== undefined && /^\d+(\.\d+)?$/.test(s) ? Number(s) : null);
  const mib = (s: string | undefined) => {
    const v = toNumber(s);
    return v === null ? null : Math.round(v * 1024 * 1024);
  };
  return { name: name || null, usedPct: toNumber(utilization), memoryUsedBytes: mib(used), memoryTotalBytes: mib(total) };
}

/** `/proc/net/route`: the default route's interface (zero destination and mask), the one with the lowest metric. */
export function parseProcNetRoute(out: string): string | null {
  let best: { iface: string; metric: number } | null = null;
  for (const l of out.split('\n').slice(1)) {
    const t = l.trim().split(/\s+/);
    if (t.length < 8 || t[1] !== '00000000' || t[7] !== '00000000') continue;
    const metric = Number(t[6]) || 0;
    if (!best || metric < best.metric) best = { iface: t[0], metric };
  }
  return best?.iface ?? null;
}

/** `/proc/net/dev`: the interface's received (1st column) and sent (9th) bytes. */
export function parseProcNetDev(out: string, iface: string): { rxBytes: number; txBytes: number } | null {
  for (const l of out.split('\n')) {
    const m = /^\s*([^:\s]+):\s*(.*)$/.exec(l);
    if (!m || m[1] !== iface) continue;
    const c = m[2].trim().split(/\s+/).map(Number);
    if (c.length >= 9 && Number.isFinite(c[0]) && Number.isFinite(c[8])) return { rxBytes: c[0], txBytes: c[8] };
  }
  return null;
}

/** `ss -ltnp`: `LISTEN 0 4096 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=812,fd=3))`. */
export function parseSs(out: string): ListeningPort[] {
  const ports: ListeningPort[] = [];
  for (const l of out.split('\n')) {
    const t = l.trim().split(/\s+/);
    if (t[0] !== 'LISTEN' || t.length < 5) continue;
    const local = t[3];
    const sep = local.lastIndexOf(':');
    const port = Number(local.slice(sep + 1));
    if (sep < 0 || !Number.isInteger(port)) continue;
    const proc = /\(\("([^"]+)",pid=(\d+)/.exec(t.slice(5).join(' '));
    ports.push({ port, ...listenInterfaceOf(local.slice(0, sep)), process: proc?.[1] ?? null, pid: proc ? Number(proc[2]) : null });
  }
  return mergePorts(ports);
}

/** `PRETTY_NAME="Ubuntu 24.04.1 LTS"`. */
export function parseOsRelease(out: string): string | null {
  return /^PRETTY_NAME="?([^"\n]+)"?\s*$/m.exec(out)?.[1] ?? null;
}

export class LinuxCollector extends PlatformCollector {
  protected readonly platform = 'linux' as const;

  protected async readOsName(): Promise<string | null> {
    const out = await this.deps.readFile('/etc/os-release');
    return out ? parseOsRelease(out) : null;
  }

  protected async memory(): Promise<MemoryReading> {
    const { os } = this.deps;
    const out = await this.deps.readFile('/proc/meminfo');
    const m = out ? parseMeminfo(out) : {};
    const total = m.MemTotal ?? os.totalmem();
    const available = m.MemAvailable ?? os.freemem();
    const swapTotal = m.SwapTotal ?? null;
    return {
      totalBytes: total,
      usedBytes: Math.max(0, total - available),
      swapTotalBytes: swapTotal,
      swapUsedBytes: swapTotal !== null && m.SwapFree !== undefined ? Math.max(0, swapTotal - m.SwapFree) : null,
      pressure: null,
    };
  }

  protected async gpu(): Promise<GpuReading | null> {
    const out = await this.run('nvidia-smi', ['--query-gpu=name,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits']);
    return out ? parseNvidiaSmi(out) : null;
  }

  protected async netCounters(): Promise<Omit<NetCounters, 'atMs'> | null> {
    const routeOut = await this.deps.readFile('/proc/net/route');
    const iface = routeOut ? parseProcNetRoute(routeOut) : null;
    if (!iface) return null;
    const dev = await this.deps.readFile('/proc/net/dev');
    const c = dev ? parseProcNetDev(dev, iface) : null;
    return c ? { interface: iface, ...c } : null;
  }

  protected async processes(): Promise<ProcessSnapshot | null> {
    const [stats, args] = await Promise.all([this.run('ps', ['-eo', 'pid=,pcpu=,rss=,comm=']), this.run('ps', ['-eo', 'pid=,etime=,args='])]);
    if (stats === null) return null;
    return { stats: parsePsStats(stats), args: args ? parsePsArgs(args) : [] };
  }

  protected async listeningPorts(): Promise<ListeningPort[] | null> {
    const out = await this.run('ss', ['-ltnp']);
    return out === null ? null : parseSs(out);
  }

  protected async tunnels(): Promise<TunnelReading[] | null> {
    return null;
  }
}
