// What the Mac and Linux collectors have in common (#175): parsing the output of `df -P`, `ps` and
// `docker`, CPU usage and network rate from the difference between two samples, and the base class
// that assembles the reading. Every parsing function is pure and takes the command output as text:
// tests run over recorded outputs (test/fixtures/telemetry), never over the system.
//
// Rule for every group: a command that is missing, fails or times out returns `null` from the
// runner, and the group (or the field) comes out `null`. A group that throws is caught here and also
// comes out `null`.

import { isClaude } from '../../states/probe.ts';
import { buildTerminals, DARWIN_TERMINALS_PS, LINUX_TERMINALS_PS, parseTerminalsPs, parseTunnelSshd } from '../terminals.ts';
import type {
  ClaudeProcesses,
  CpuReading,
  DockerReading,
  DockerSpace,
  DockerStack,
  GpuReading,
  HostInfo,
  ListenInterface,
  ListeningPort,
  MemoryReading,
  NetworkReading,
  ProcessGroup,
  TelemetryReading,
  TerminalsReading,
  TopProcess,
  TunnelReading,
  VolumeReading,
} from '../model.ts';
import type { CollectorDeps, CpuTimes, TelemetryCollector } from '../ports.ts';

/** Each command's timeout: short, so a sample never takes more than the 30 s. */
export const COMMAND_TIMEOUT_MS = 2_500;
/** `docker system df` adds up sizes and tends to be the slowest. */
export const DOCKER_DF_TIMEOUT_MS = 3_000;
/** The wait before the first reading: CPU and network need two measurements. */
export const PRIME_MS = 1_000;
export const TOP_PROCESSES = 6;

const n = (s: string | undefined) => (s === undefined ? NaN : Number(s));
const round1 = (x: number) => Math.round(x * 10) / 10;
const round2 = (x: number) => Math.round(x * 100) / 100;

/** Runs the group; whatever it throws becomes `null` (the field is absent, the reading goes on). */
export async function orNull<T>(f: () => Promise<T | null>): Promise<T | null> {
  try {
    return await f();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// df -P: only to list the mount points. The size comes from `fs.statfs`.

export interface DfRow {
  filesystem: string;
  mount: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
}

/** `df -P` on the Mac (512-byte blocks) and on Linux (1024): the block size comes from the header. */
export function parseDfP(out: string): DfRow[] {
  const lines = out.split('\n');
  const blockSize = Number(/(\d+)-blocks/.exec(lines[0] ?? '')?.[1] ?? 1024);
  const rows: DfRow[] = [];
  for (const l of lines.slice(1)) {
    const m = /^(.+?)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+%|-)\s+(\/.*)$/.exec(l.trimEnd());
    if (!m) continue;
    rows.push({ filesystem: m[1], mount: m[6], totalBytes: n(m[2]) * blockSize, usedBytes: n(m[3]) * blockSize, availableBytes: n(m[4]) * blockSize });
  }
  return rows;
}

const PSEUDO_FS = /^(?:tmpfs|devtmpfs|devfs|udev|overlay|none|shm|efivarfs|map\s.*|\/dev\/loop\d+)$/;
const PSEUDO_MOUNT = /^\/(?:dev|proc|sys|run|snap|boot\/efi|private\/var\/vm|System\/Volumes)(?:\/|$)/;

/** Left out: pseudo file systems, snaps and, on the Mac, the APFS system volumes. */
export function isRealVolume(r: DfRow): boolean {
  return r.totalBytes > 0 && !PSEUDO_FS.test(r.filesystem) && !PSEUDO_MOUNT.test(r.mount);
}

/**
 * The volumes from each mount point's `fs.statfs` (used = total − available, which on APFS gives the
 * whole container, like Finder). Without `statfs`, the numbers from `df` itself.
 */
export async function volumesOf(rows: DfRow[], deps: CollectorDeps): Promise<VolumeReading[]> {
  const out: VolumeReading[] = [];
  for (const r of rows.filter(isRealVolume)) {
    const s = await deps.statfs(r.mount).catch(() => null);
    const total = s?.totalBytes ?? r.totalBytes;
    const free = s?.availableBytes ?? r.availableBytes;
    const used = s ? Math.max(0, total - free) : r.usedBytes;
    if (total <= 0) continue;
    out.push({ mount: r.mount, totalBytes: total, usedBytes: used, freeBytes: free, usedPct: round1((used / total) * 100) });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// ps

export interface PsRow {
  pid: number;
  cpuPct: number;
  rssBytes: number;
  /** The executable (`comm`): the full path on the Mac, the short name on Linux. */
  comm: string;
}

/** Output of `ps … -o pid=,pcpu=,rss=,comm=`. */
export function parsePsStats(out: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const l of out.split('\n')) {
    const m = /^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(.+?)\s*$/.exec(l);
    if (m) rows.push({ pid: n(m[1]), cpuPct: n(m[2]), rssBytes: n(m[3]) * 1024, comm: m[4] });
  }
  return rows;
}

export interface PsArgsRow {
  pid: number;
  /** How many seconds the process has been running; `null` when `etime` made no sense. */
  elapsedSec: number | null;
  args: string;
  /** The uid owning the process, when `ps` provided it (`parsePsUidArgs`). */
  uid?: number;
}

/** `ps` `etime`: `[[dd-]hh:]mm:ss`. */
export function parseEtime(s: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(s.trim());
  if (!m) return null;
  return n(m[1] ?? '0') * 86_400 + n(m[2] ?? '0') * 3_600 + n(m[3]) * 60 + n(m[4]);
}

/** Output of `ps … -o pid=,etime=,args=`. */
export function parsePsArgs(out: string): PsArgsRow[] {
  const rows: PsArgsRow[] = [];
  for (const l of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s+(.*?)\s*$/.exec(l);
    if (m) rows.push({ pid: n(m[1]), elapsedSec: parseEtime(m[2]), args: m[3] });
  }
  return rows;
}

/** Output of `ps … -o pid=,uid=,etime=,args=`: the same, with each process's owner. */
export function parsePsUidArgs(out: string): PsArgsRow[] {
  const rows: PsArgsRow[] = [];
  for (const l of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*?)\s*$/.exec(l);
    if (m) rows.push({ pid: n(m[1]), uid: n(m[2]), elapsedSec: parseEtime(m[3]), args: m[4] });
  }
  return rows;
}

export const baseName = (comm: string) => comm.slice(comm.lastIndexOf('/') + 1);

/** A Claude Desktop process: the app and its helpers, all inside `Claude.app`. */
export const isClaudeDesktop = (comm: string) => comm.includes('/Claude.app/');

const group = (rows: PsRow[]): ProcessGroup => ({
  count: rows.length,
  cpuPct: round1(rows.reduce((a, r) => a + r.cpuPct, 0)),
  memoryBytes: rows.reduce((a, r) => a + r.rssBytes, 0),
});

/** CLI (`claude`, by its command line) and Claude Desktop, added together and separately. */
export function claudeOf(stats: PsRow[], args: PsArgsRow[]): ClaudeProcesses {
  const line = new Map(args.map((a) => [a.pid, a.args]));
  const desktop = stats.filter((r) => isClaudeDesktop(r.comm));
  // The npm package runs on node with `process.title = 'claude'`: `comm` says what the command line does not.
  const cli = stats.filter((r) => !isClaudeDesktop(r.comm) && (baseName(r.comm) === 'claude' || isClaude(line.get(r.pid) ?? r.comm)));
  return { processes: group([...cli, ...desktop]), cli: group(cli), desktop: group(desktop) };
}

/** Only observed executable identities, never a substring in another process's prompt/args. */
export function codexOf(stats: PsRow[]): ClaudeProcesses {
  const desktop = stats.filter(r => r.comm.includes('/Codex.app/'));
  const cli = stats.filter(r => !r.comm.includes('/Codex.app/') && ['codex', 'codex.exe'].includes(baseName(r.comm)));
  return { processes: group([...cli, ...desktop]), cli: group(cli), desktop: group(desktop) };
}

export function topProcessesOf(stats: PsRow[], k = TOP_PROCESSES): TopProcess[] {
  return [...stats]
    .sort((a, b) => b.cpuPct - a.cpuPct || a.pid - b.pid)
    .slice(0, k)
    .map((r) => ({ pid: r.pid, name: baseName(r.comm), cpuPct: r.cpuPct, memoryBytes: r.rssBytes }));
}

// ---------------------------------------------------------------------------------------------
// Docker

export const DOCKER_PS_ARGS = ['ps', '-a', '--no-trunc', '--format', '{{.State}}\t{{.Label "com.docker.compose.project"}}\t{{.Ports}}'];
export const DOCKER_DF_ARGS = ['system', 'df', '--format', '{{.Type}}\t{{.TotalCount}}\t{{.Active}}\t{{.Size}}\t{{.Reclaimable}}'];

const RUNNING_STATES = new Set(['running', 'restarting']);

/** The host ports published in `{{.Ports}}` (`0.0.0.0:15432->5432/tcp, :::15432->5432/tcp`). */
export function publishedPorts(ports: string): number[] {
  const out = new Set<number>();
  for (const m of ports.matchAll(/:(\d+)(?:-(\d+))?->/g)) {
    const from = n(m[1]);
    const to = m[2] ? n(m[2]) : from;
    for (let p = from; p <= to && p - from < 64; p++) out.add(p);
  }
  return [...out].sort((a, b) => a - b);
}

/** Output of `docker ps -a` with `DOCKER_PS_ARGS`: the counters and the Compose stacks. */
export function parseDockerPs(out: string): Omit<DockerReading, 'space'> {
  let running = 0;
  let stopped = 0;
  const stacks = new Map<string, DockerStack>();
  for (const l of out.split('\n')) {
    if (!l.trim()) continue;
    const [state = '', project = '', ports = ''] = l.split('\t');
    const isRunning = RUNNING_STATES.has(state.trim());
    if (isRunning) running++;
    else stopped++;
    const name = project.trim();
    if (!name) continue;
    const s = stacks.get(name) ?? { name: name, running: 0, stopped: 0, ports: [] };
    if (isRunning) s.running++;
    else s.stopped++;
    s.ports = [...new Set([...s.ports, ...publishedPorts(ports)])].sort((a, b) => a - b);
    stacks.set(name, s);
  }
  return { running, stopped, stacks: [...stacks.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

const UNIT_FACTORS: Record<string, number> = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, pb: 1e15 };

/** `25.2GB`, `0B`, `8.7GB (34%)`: Docker writes units of 1000. */
export function parseDockerSize(s: string): number | null {
  const m = /^\s*([\d.]+)\s*([kKmMgGtTpP]?B)\b/.exec(s);
  if (!m) return null;
  const f = UNIT_FACTORS[m[2].toLowerCase()];
  return f === undefined ? null : Math.round(n(m[1]) * f);
}

export function parseDockerDf(out: string): DockerSpace[] {
  const rows: DockerSpace[] = [];
  for (const l of out.split('\n')) {
    const [type, total, active, size, reclaimable] = l.split('\t');
    if (!type?.trim() || size === undefined) continue;
    rows.push({
      type: type.trim(),
      totalCount: n(total) || 0,
      active: n(active) || 0,
      sizeBytes: parseDockerSize(size) ?? 0,
      reclaimableBytes: parseDockerSize(reclaimable ?? '') ?? 0,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Listening ports

/** `*`, `0.0.0.0`, `[::]`: all; `127.0.0.1`, `[::1]`, `localhost`: this machine only. */
export function listenInterfaceOf(host: string): { interface: ListenInterface; address: string | null } {
  const h = host.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (h === '*' || h === '0.0.0.0' || h === '::' || h === '') return { interface: 'all', address: null };
  if (h === 'localhost' || h === '::1' || /^127\./.test(h) || h === '::ffff:127.0.0.1') return { interface: 'loopback', address: null };
  return { interface: 'address', address: h };
}

/** One row per port and process, with the most open interface when the same process listens on IPv4 and IPv6. */
export function mergePorts(ports: ListeningPort[]): ListeningPort[] {
  const rank: Record<ListenInterface, number> = { all: 0, address: 1, loopback: 2 };
  const byKey = new Map<string, ListeningPort>();
  for (const p of ports) {
    const k = `${p.port}\0${p.pid ?? p.process ?? ''}`;
    const current = byKey.get(k);
    if (!current || rank[p.interface] < rank[current.interface]) byKey.set(k, p);
  }
  return [...byKey.values()].sort((a, b) => a.port - b.port || (a.pid ?? 0) - (b.pid ?? 0));
}

// ---------------------------------------------------------------------------------------------
// CPU and network: from the difference between two measurements

const busyTime = (t: CpuTimes) => t.user + t.nice + t.sys + t.irq;
const total = (t: CpuTimes) => busyTime(t) + t.idle;

/** Usage of all cores between two `os.cpus()` measurements, 0 to 100; `null` without a difference. */
export function cpuUsedPct(before: { times: CpuTimes }[], after: { times: CpuTimes }[]): number | null {
  if (before.length === 0 || before.length !== after.length) return null;
  let o = 0;
  let t = 0;
  for (let i = 0; i < after.length; i++) {
    o += busyTime(after[i].times) - busyTime(before[i].times);
    t += total(after[i].times) - total(before[i].times);
  }
  if (!(t > 0) || o < 0) return null;
  return round1(Math.min(100, (o / t) * 100));
}

export interface NetCounters {
  interface: string;
  rxBytes: number;
  txBytes: number;
  atMs: number;
}

/** The rate between two measurements of the same interface; `null` when the interface changed or the counter went back. */
export function networkOf(current: NetCounters, previous: NetCounters | null): NetworkReading {
  const dt = previous ? (current.atMs - previous.atMs) / 1000 : 0;
  const ok = previous !== null && previous.interface === current.interface && dt > 0 && current.rxBytes >= previous.rxBytes && current.txBytes >= previous.txBytes;
  return {
    interface: current.interface,
    rxBytesPerSec: ok ? Math.round((current.rxBytes - previous!.rxBytes) / dt) : null,
    txBytesPerSec: ok ? Math.round((current.txBytes - previous!.txBytes) / dt) : null,
    rxBytesTotal: current.rxBytes,
    txBytesTotal: current.txBytes,
  };
}

// ---------------------------------------------------------------------------------------------
// The base class

/** The processes, read once per sample and shared between the groups. */
export interface ProcessSnapshot {
  stats: PsRow[];
  args: PsArgsRow[];
}

export abstract class PlatformCollector implements TelemetryCollector {
  protected readonly deps: CollectorDeps;
  private prevCpus: { times: CpuTimes }[] | null = null;
  private prevNet: NetCounters | null = null;
  private osName: string | null | undefined = undefined;

  constructor(deps: CollectorDeps) {
    this.deps = deps;
  }

  protected abstract readonly platform: HostInfo['platform'];
  protected abstract readOsName(): Promise<string | null>;
  protected abstract memory(): Promise<MemoryReading>;
  protected abstract gpu(): Promise<GpuReading | null>;
  protected abstract netCounters(): Promise<Omit<NetCounters, 'atMs'> | null>;
  protected abstract processes(): Promise<ProcessSnapshot | null>;
  protected abstract listeningPorts(): Promise<ListeningPort[] | null>;
  protected abstract tunnels(ps: ProcessSnapshot | null, ports: ListeningPort[] | null): Promise<TunnelReading[] | null>;

  protected now(): number {
    return (this.deps.now ?? Date.now)();
  }

  protected run(command: string, args: readonly string[], timeoutMs = COMMAND_TIMEOUT_MS): Promise<string | null> {
    return this.deps.run(command, args, { timeoutMs }).catch(() => null);
  }

  private async netSample(): Promise<NetCounters | null> {
    const c = await orNull(() => this.netCounters());
    return c ? { ...c, atMs: this.now() } : null;
  }

  async collect(): Promise<TelemetryReading> {
    const os = this.deps.os;
    if (this.prevCpus === null) {
      // The first one: one measurement, the wait and a second one, so CPU and network are filled from the first sample.
      this.prevCpus = os.cpus();
      this.prevNet = await this.netSample();
      await (this.deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(PRIME_MS);
    }
    if (this.osName === undefined) this.osName = await orNull(() => this.readOsName());

    const cpus = os.cpus();
    const [load1 = 0, load5 = 0, load15 = 0] = os.loadavg();
    const cpu: CpuReading = {
      cores: cpus.length,
      model: cpus[0]?.model?.trim() || null,
      usedPct: cpuUsedPct(this.prevCpus, cpus),
      load: { one: round2(load1), five: round2(load5), fifteen: round2(load15) },
    };
    this.prevCpus = cpus;

    const [memory, gpu, df, netSample, ps, ports, docker, terminals] = await Promise.all([
      this.memory().catch(() => ({ totalBytes: os.totalmem(), usedBytes: os.totalmem() - os.freemem(), swapTotalBytes: null, swapUsedBytes: null, pressure: null })),
      orNull(() => this.gpu()),
      this.run('df', ['-P']),
      this.netSample(),
      orNull(() => this.processes()),
      orNull(() => this.listeningPorts()),
      orNull(() => this.docker()),
      orNull(() => this.terminals()),
    ]);
    const network = netSample ? networkOf(netSample, this.prevNet) : null;
    this.prevNet = netSample;
    const tunnels = await orNull(() => this.tunnels(ps, ports));

    const host: HostInfo = { hostname: os.hostname(), platform: this.platform, os: this.osName ?? null, arch: os.arch(), uptimeSec: Math.round(os.uptime()) };
    return {
      takenAt: new Date(this.now()).toISOString(),
      host,
      cpu,
      memory,
      gpu,
      disk: { volumes: df ? await volumesOf(parseDfP(df), this.deps) : [] },
      network,
      claude: ps ? claudeOf(ps.stats, ps.args) : null,
      codex: ps ? codexOf(ps.stats) : null,
      topProcesses: ps ? topProcessesOf(ps.stats) : null,
      docker,
      ports,
      tunnels,
      terminals,
    };
  }

  /** The terminal sessions (#350); `null` when `ps` did not answer. */
  async terminals(): Promise<TerminalsReading | null> {
    const out = await this.run('ps', this.platform === 'darwin' ? DARWIN_TERMINALS_PS : LINUX_TERMINALS_PS);
    if (out === null) return null;
    const { corePort } = this.deps;
    const ss = this.platform === 'linux' && corePort !== undefined ? await this.run('ss', ['-tnp']) : null;
    return buildTerminals(parseTerminalsPs(out), {
      nowMs: this.now(),
      uid: this.deps.os.uid(),
      selfPid: this.deps.selfPid ?? process.pid,
      tunnelSshd: ss && corePort !== undefined ? parseTunnelSshd(ss, corePort) : undefined,
      interactive: this.deps.interactiveCommands?.(),
      remoteActions: this.deps.acceptRemoteActions?.() ?? false,
    });
  }

  /** `null` without `docker` on the PATH or without the daemon (`docker ps` fails). */
  protected async docker(): Promise<DockerReading | null> {
    const ps = await this.run('docker', DOCKER_PS_ARGS);
    if (ps === null) return null;
    const df = await this.run('docker', DOCKER_DF_ARGS, DOCKER_DF_TIMEOUT_MS);
    return { ...parseDockerPs(ps), space: df === null ? null : parseDockerDf(df) };
  }
}
