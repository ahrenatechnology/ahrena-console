// O que os coletores do Mac e do Linux têm em comum (#175): a leitura das saídas de `df -P`, `ps`
// e `docker`, o uso de CPU e a taxa da rede pela diferença entre duas amostras, e a classe base que
// monta a leitura. Cada função de leitura é pura e recebe a saída do comando como texto: os testes
// rodam sobre saídas gravadas (test/fixtures/telemetry), nunca sobre o sistema.
//
// Regra de todos os grupos: comando que falta, falha ou estoura o tempo devolve `null` no runner, e
// o grupo (ou o campo) sai `null`. Um grupo que lança é pego aqui e também sai `null`.

import { ehClaude } from '../../estados/sonda.ts';
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
  TopProcess,
  TunnelReading,
  VolumeReading,
} from '../model.ts';
import type { CollectorDeps, CpuTimes, TelemetryCollector } from '../ports.ts';

/** O tempo de cada comando: curto, para uma amostra nunca passar dos 30 s. */
export const COMMAND_TIMEOUT_MS = 2_500;
/** O `docker system df` soma tamanhos e costuma ser o mais lento. */
export const DOCKER_DF_TIMEOUT_MS = 3_000;
/** A espera da primeira leitura: CPU e rede precisam de duas medidas. */
export const PRIME_MS = 1_000;
export const TOP_PROCESSES = 6;

const n = (s: string | undefined) => (s === undefined ? NaN : Number(s));
const round1 = (x: number) => Math.round(x * 10) / 10;
const round2 = (x: number) => Math.round(x * 100) / 100;

/** Roda o grupo; o que lançar vira `null` (o campo fica ausente, a leitura continua). */
export async function orNull<T>(f: () => Promise<T | null>): Promise<T | null> {
  try {
    return await f();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// df -P: só para listar os pontos de montagem. O tamanho vem do `fs.statfs`.

export interface DfRow {
  filesystem: string;
  mount: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
}

/** `df -P` no Mac (blocos de 512) e no Linux (de 1024): o tamanho do bloco vem do cabeçalho. */
export function parseDfP(out: string): DfRow[] {
  const linhas = out.split('\n');
  const bloco = Number(/(\d+)-blocks/.exec(linhas[0] ?? '')?.[1] ?? 1024);
  const rows: DfRow[] = [];
  for (const l of linhas.slice(1)) {
    const m = /^(.+?)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+%|-)\s+(\/.*)$/.exec(l.trimEnd());
    if (!m) continue;
    rows.push({ filesystem: m[1], mount: m[6], totalBytes: n(m[2]) * bloco, usedBytes: n(m[3]) * bloco, availableBytes: n(m[4]) * bloco });
  }
  return rows;
}

const PSEUDO_FS = /^(?:tmpfs|devtmpfs|devfs|udev|overlay|none|shm|efivarfs|map\s.*|\/dev\/loop\d+)$/;
const PSEUDO_MOUNT = /^\/(?:dev|proc|sys|run|snap|boot\/efi|private\/var\/vm|System\/Volumes)(?:\/|$)/;

/** Fora: os sistemas de arquivos de mentira, os snaps e, no Mac, os volumes de sistema do APFS. */
export function isRealVolume(r: DfRow): boolean {
  return r.totalBytes > 0 && !PSEUDO_FS.test(r.filesystem) && !PSEUDO_MOUNT.test(r.mount);
}

/**
 * Os volumes pelo `fs.statfs` de cada ponto (usado = total − disponível, o que no APFS dá o
 * contêiner inteiro, como o Finder). Sem o `statfs`, os números do próprio `df`.
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
  /** O executável (`comm`): o caminho inteiro no Mac, o nome curto no Linux. */
  comm: string;
}

/** Saída de `ps … -o pid=,pcpu=,rss=,comm=`. */
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
  /** Há quantos segundos o processo roda; `null` quando o `etime` não fez sentido. */
  elapsedSec: number | null;
  args: string;
}

/** `etime` do ps: `[[dd-]hh:]mm:ss`. */
export function parseEtime(s: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(s.trim());
  if (!m) return null;
  return n(m[1] ?? '0') * 86_400 + n(m[2] ?? '0') * 3_600 + n(m[3]) * 60 + n(m[4]);
}

/** Saída de `ps … -o pid=,etime=,args=`. */
export function parsePsArgs(out: string): PsArgsRow[] {
  const rows: PsArgsRow[] = [];
  for (const l of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s+(.*?)\s*$/.exec(l);
    if (m) rows.push({ pid: n(m[1]), elapsedSec: parseEtime(m[2]), args: m[3] });
  }
  return rows;
}

export const baseName = (comm: string) => comm.slice(comm.lastIndexOf('/') + 1);

/** Processo do Claude Desktop: o app e os helpers dele, todos dentro de `Claude.app`. */
export const isClaudeDesktop = (comm: string) => comm.includes('/Claude.app/');

const grupo = (rows: PsRow[]): ProcessGroup => ({
  count: rows.length,
  cpuPct: round1(rows.reduce((a, r) => a + r.cpuPct, 0)),
  memoryBytes: rows.reduce((a, r) => a + r.rssBytes, 0),
});

/** CLI (`claude`, pela linha de comando) e Claude Desktop, somados e em separado. */
export function claudeOf(stats: PsRow[], args: PsArgsRow[]): ClaudeProcesses {
  const linha = new Map(args.map((a) => [a.pid, a.args]));
  const desktop = stats.filter((r) => isClaudeDesktop(r.comm));
  // O pacote npm roda no node com `process.title = 'claude'`: o `comm` diz o que a linha de comando não diz.
  const cli = stats.filter((r) => !isClaudeDesktop(r.comm) && (baseName(r.comm) === 'claude' || ehClaude(linha.get(r.pid) ?? r.comm)));
  return { processes: grupo([...cli, ...desktop]), cli: grupo(cli), desktop: grupo(desktop) };
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

const RODANDO = new Set(['running', 'restarting']);

/** As portas publicadas no host de `{{.Ports}}` (`0.0.0.0:15432->5432/tcp, :::15432->5432/tcp`). */
export function publishedPorts(ports: string): number[] {
  const out = new Set<number>();
  for (const m of ports.matchAll(/:(\d+)(?:-(\d+))?->/g)) {
    const de = n(m[1]);
    const ate = m[2] ? n(m[2]) : de;
    for (let p = de; p <= ate && p - de < 64; p++) out.add(p);
  }
  return [...out].sort((a, b) => a - b);
}

/** Saída de `docker ps -a` com `DOCKER_PS_ARGS`: os contadores e as stacks do Compose. */
export function parseDockerPs(out: string): Omit<DockerReading, 'space'> {
  let running = 0;
  let stopped = 0;
  const stacks = new Map<string, DockerStack>();
  for (const l of out.split('\n')) {
    if (!l.trim()) continue;
    const [state = '', project = '', ports = ''] = l.split('\t');
    const vivo = RODANDO.has(state.trim());
    if (vivo) running++;
    else stopped++;
    const nome = project.trim();
    if (!nome) continue;
    const s = stacks.get(nome) ?? { name: nome, running: 0, stopped: 0, ports: [] };
    if (vivo) s.running++;
    else s.stopped++;
    s.ports = [...new Set([...s.ports, ...publishedPorts(ports)])].sort((a, b) => a - b);
    stacks.set(nome, s);
  }
  return { running, stopped, stacks: [...stacks.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

const UNIDADE: Record<string, number> = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, pb: 1e15 };

/** `25.2GB`, `0B`, `8.7GB (34%)`: o Docker escreve em unidades de 1000. */
export function parseDockerSize(s: string): number | null {
  const m = /^\s*([\d.]+)\s*([kKmMgGtTpP]?B)\b/.exec(s);
  if (!m) return null;
  const f = UNIDADE[m[2].toLowerCase()];
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
// Portas em escuta

/** `*`, `0.0.0.0`, `[::]`: todas; `127.0.0.1`, `[::1]`, `localhost`: só esta máquina. */
export function listenInterfaceOf(host: string): { interface: ListenInterface; address: string | null } {
  const h = host.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (h === '*' || h === '0.0.0.0' || h === '::' || h === '') return { interface: 'all', address: null };
  if (h === 'localhost' || h === '::1' || /^127\./.test(h) || h === '::ffff:127.0.0.1') return { interface: 'loopback', address: null };
  return { interface: 'address', address: h };
}

/** Uma linha por porta e processo, a interface mais aberta quando o mesmo processo escuta em IPv4 e IPv6. */
export function mergePorts(ports: ListeningPort[]): ListeningPort[] {
  const ordem: Record<ListenInterface, number> = { all: 0, address: 1, loopback: 2 };
  const porChave = new Map<string, ListeningPort>();
  for (const p of ports) {
    const k = `${p.port}\0${p.pid ?? p.process ?? ''}`;
    const atual = porChave.get(k);
    if (!atual || ordem[p.interface] < ordem[atual.interface]) porChave.set(k, p);
  }
  return [...porChave.values()].sort((a, b) => a.port - b.port || (a.pid ?? 0) - (b.pid ?? 0));
}

// ---------------------------------------------------------------------------------------------
// CPU e rede: pela diferença entre duas medidas

const ocupado = (t: CpuTimes) => t.user + t.nice + t.sys + t.irq;
const total = (t: CpuTimes) => ocupado(t) + t.idle;

/** Uso de todos os núcleos entre duas medidas de `os.cpus()`, 0 a 100; `null` sem diferença. */
export function cpuUsedPct(antes: { times: CpuTimes }[], depois: { times: CpuTimes }[]): number | null {
  if (antes.length === 0 || antes.length !== depois.length) return null;
  let o = 0;
  let t = 0;
  for (let i = 0; i < depois.length; i++) {
    o += ocupado(depois[i].times) - ocupado(antes[i].times);
    t += total(depois[i].times) - total(antes[i].times);
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

/** A taxa entre duas medidas da mesma interface; `null` quando mudou de interface ou o contador voltou. */
export function networkOf(atual: NetCounters, anterior: NetCounters | null): NetworkReading {
  const dt = anterior ? (atual.atMs - anterior.atMs) / 1000 : 0;
  const ok = anterior !== null && anterior.interface === atual.interface && dt > 0 && atual.rxBytes >= anterior.rxBytes && atual.txBytes >= anterior.txBytes;
  return {
    interface: atual.interface,
    rxBytesPerSec: ok ? Math.round((atual.rxBytes - anterior!.rxBytes) / dt) : null,
    txBytesPerSec: ok ? Math.round((atual.txBytes - anterior!.txBytes) / dt) : null,
    rxBytesTotal: atual.rxBytes,
    txBytesTotal: atual.txBytes,
  };
}

// ---------------------------------------------------------------------------------------------
// A classe base

/** Os processos, lidos uma vez por amostra e repartidos entre os grupos. */
export interface ProcessSnapshot {
  stats: PsRow[];
  args: PsArgsRow[];
}

export abstract class PlatformCollector implements TelemetryCollector {
  protected readonly deps: CollectorDeps;
  private cpuAntes: { times: CpuTimes }[] | null = null;
  private redeAntes: NetCounters | null = null;
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

  private async rede(): Promise<NetCounters | null> {
    const c = await orNull(() => this.netCounters());
    return c ? { ...c, atMs: this.now() } : null;
  }

  async collect(): Promise<TelemetryReading> {
    const os = this.deps.os;
    if (this.cpuAntes === null) {
      // A primeira: uma medida, a espera e a segunda, para CPU e rede saírem já na primeira amostra.
      this.cpuAntes = os.cpus();
      this.redeAntes = await this.rede();
      await (this.deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(PRIME_MS);
    }
    if (this.osName === undefined) this.osName = await orNull(() => this.readOsName());

    const cpus = os.cpus();
    const [load1 = 0, load5 = 0, load15 = 0] = os.loadavg();
    const cpu: CpuReading = {
      cores: cpus.length,
      model: cpus[0]?.model?.trim() || null,
      usedPct: cpuUsedPct(this.cpuAntes, cpus),
      load: { one: round2(load1), five: round2(load5), fifteen: round2(load15) },
    };
    this.cpuAntes = cpus;

    const [memory, gpu, df, rede, ps, ports, docker] = await Promise.all([
      this.memory().catch(() => ({ totalBytes: os.totalmem(), usedBytes: os.totalmem() - os.freemem(), swapTotalBytes: null, swapUsedBytes: null, pressure: null })),
      orNull(() => this.gpu()),
      this.run('df', ['-P']),
      this.rede(),
      orNull(() => this.processes()),
      orNull(() => this.listeningPorts()),
      orNull(() => this.docker()),
    ]);
    const network = rede ? networkOf(rede, this.redeAntes) : null;
    this.redeAntes = rede;
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
      topProcesses: ps ? topProcessesOf(ps.stats) : null,
      docker,
      ports,
      tunnels,
    };
  }

  /** `null` sem o `docker` no PATH ou sem o daemon (o `docker ps` falha). */
  protected async docker(): Promise<DockerReading | null> {
    const ps = await this.run('docker', DOCKER_PS_ARGS);
    if (ps === null) return null;
    const df = await this.run('docker', DOCKER_DF_ARGS, DOCKER_DF_TIMEOUT_MS);
    return { ...parseDockerPs(ps), space: df === null ? null : parseDockerDf(df) };
  }
}
