// Coletor do Mac (#175, decisão 0008). Só leitura, sem `sudo`, com os comandos que já vêm no macOS:
//
// | Grupo    | De onde                                                                      |
// | -------- | ---------------------------------------------------------------------------- |
// | Memória  | `vm_stat` (usada), `sysctl vm.swapusage`, `sysctl kern.memorystatus_vm_pressure_level` |
// | GPU      | `ioreg -r -d 1 -w 0 -c IOAccelerator` (uso e memória em uso)                 |
// | Rede     | `route -n get default` (a interface) e `netstat -ibn` (os bytes)             |
// | Processos| `ps -axo pid=,pcpu=,rss=,comm=` e `ps -axo pid=,etime=,args=`                |
// | Portas   | `lsof -nP -iTCP -sTCP:LISTEN` (só os processos do usuário, sem `sudo`)       |
// | Túnel    | os `ssh` com `-L` na linha de comando ou `LocalForward` no `ssh -G <destino>`, e a sonda de cada porta |
//
// O sistema e a versão saem de `sw_vers -productVersion`, uma vez.

import type { GpuReading, ListeningPort, MemoryPressure, MemoryReading, TunnelPort, TunnelReading } from '../model.ts';
import {
  baseName,
  listenInterfaceOf,
  mergePorts,
  parsePsArgs,
  parsePsStats,
  PlatformCollector,
  type NetCounters,
  type ProcessSnapshot,
  type PsArgsRow,
} from './common.ts';

// ---------------------------------------------------------------------------------------------
// Memória

export function parseVmStat(out: string): { pageSize: number; pages: Record<string, number> } | null {
  const pageSize = Number(/page size of (\d+) bytes/.exec(out)?.[1]);
  if (!pageSize) return null;
  const pages: Record<string, number> = {};
  for (const m of out.matchAll(/^"?([^":\n]+)"?:\s+(\d+)\.?\s*$/gm)) pages[m[1].trim()] = Number(m[2]);
  return { pageSize, pages };
}

/**
 * Memória usada como o Monitor de Atividade conta: memória de apps (anônimas menos as purgáveis),
 * fixa (wired) e comprimida. Sem as anônimas (macOS antigo), as ativas.
 */
export function usedFromVmStat(vm: { pageSize: number; pages: Record<string, number> }): number | null {
  const p = vm.pages;
  const wired = p['Pages wired down'];
  const comprimida = p['Pages occupied by compressor'] ?? 0;
  const apps = p['Anonymous pages'] !== undefined ? p['Anonymous pages'] - (p['Pages purgeable'] ?? 0) : p['Pages active'];
  if (wired === undefined || apps === undefined) return null;
  return (Math.max(0, apps) + wired + comprimida) * vm.pageSize;
}

const MEGA: Record<string, number> = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };

/** `vm.swapusage: total = 2048.00M  used = 819.25M  free = 1228.75M  (encrypted)`. */
export function parseSwapUsage(out: string): { totalBytes: number; usedBytes: number } | null {
  const v = (k: string) => {
    const m = new RegExp(`${k} = ([\\d.]+)([KMGT])`).exec(out);
    return m ? Math.round(Number(m[1]) * MEGA[m[2]]) : null;
  };
  const totalBytes = v('total');
  const usedBytes = v('used');
  return totalBytes === null || usedBytes === null ? null : { totalBytes, usedBytes };
}

/** `kern.memorystatus_vm_pressure_level`: 1 normal, 2 aviso, 4 crítica. */
export function parsePressureLevel(out: string): MemoryPressure | null {
  return ({ '1': 'normal', '2': 'warning', '4': 'critical' } as const)[out.trim() as '1' | '2' | '4'] ?? null;
}

// ---------------------------------------------------------------------------------------------
// GPU

/** O primeiro acelerador de `ioreg -c IOAccelerator`: nome, uso e a memória que ele usa. */
export function parseIoregGpu(out: string): GpuReading | null {
  const uso = /"Device Utilization %"\s*=\s*(\d+)/.exec(out);
  if (!uso) return null;
  const emUso = /"In use system memory"\s*=\s*(\d+)/.exec(out);
  return {
    name: /"model"\s*=\s*"([^"]+)"/.exec(out)?.[1] ?? null,
    usedPct: Number(uso[1]),
    memoryUsedBytes: emUso ? Number(emUso[1]) : null,
    // Memória unificada: não há um total da GPU separado do da máquina.
    memoryTotalBytes: null,
  };
}

// ---------------------------------------------------------------------------------------------
// Rede

/** `route -n get default` → a interface da rota padrão. */
export function parseRouteDefault(out: string): string | null {
  return /^\s*interface:\s*(\S+)\s*$/m.exec(out)?.[1] ?? null;
}

/**
 * `netstat -ibn`, a linha `<Link#n>` da interface: as últimas sete colunas são Ipkts Ierrs Ibytes
 * Opkts Oerrs Obytes Coll (o endereço pode faltar, então conta-se do fim).
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
// Portas em escuta

/** `lsof -nP -iTCP -sTCP:LISTEN`: `COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME (LISTEN)`. */
export function parseLsofListen(out: string): ListeningPort[] {
  const ports: ListeningPort[] = [];
  for (const l of out.split('\n').slice(1)) {
    const t = l.trim().split(/\s+/);
    const i = t.indexOf('(LISTEN)');
    if (i < 2) continue;
    const nome = t[i - 1];
    const sep = nome.lastIndexOf(':');
    const port = Number(nome.slice(sep + 1));
    if (sep < 0 || !Number.isInteger(port)) continue;
    ports.push({ port, ...listenInterfaceOf(nome.slice(0, sep)), process: t[0].replace(/\\x20/g, ' '), pid: Number(t[1]) || null });
  }
  return mergePorts(ports);
}

// ---------------------------------------------------------------------------------------------
// Túnel

export interface Forward {
  localPort: number;
  remoteHost: string;
  remotePort: number;
}

/** As opções do `ssh` que levam argumento (man ssh). */
const COM_ARGUMENTO = new Set('BbcDEeFIiJLlmOoPpQRSWw');

/** `[bind:]porta:host:porta`, com IPv6 entre colchetes. Socket Unix fica de fora. */
export function parseForwardSpec(spec: string): Forward | null {
  const m = /^(?:(?:\[[^\]]+\]|[^:[\]]*):)?(\d+):(\[[^\]]+\]|[^:[\]]+):(\d+)$/.exec(spec.trim());
  if (!m) return null;
  return { localPort: Number(m[1]), remoteHost: m[2].replace(/^\[|\]$/g, ''), remotePort: Number(m[3]) };
}

export interface SshCommand {
  destination: string;
  forwards: Forward[];
  /** O `-F` da linha de comando, para o `ssh -G` ler o mesmo arquivo. */
  configFile: string | null;
}

/**
 * A linha de comando de um `ssh` (do `ps`): o destino, os `-L` e o `-F`. `null` quando não é um
 * `ssh` cliente (o mestre do ControlMaster aparece como `ssh: <socket> [mux]`).
 */
export function parseSshArgs(args: string): SshCommand | null {
  const t = args.trim().split(/\s+/);
  if (baseName(t[0] ?? '') !== 'ssh') return null;
  const forwards: Forward[] = [];
  let configFile: string | null = null;
  for (let i = 1; i < t.length; i++) {
    const tok = t[i];
    if (tok === '--') return t[i + 1] ? { destination: t[i + 1], forwards, configFile } : null;
    if (!tok.startsWith('-') || tok === '-') return { destination: tok, forwards, configFile };
    for (let j = 1; j < tok.length; j++) {
      const op = tok[j];
      if (!COM_ARGUMENTO.has(op)) continue;
      const valor = tok.length > j + 1 ? tok.slice(j + 1) : t[++i];
      if (valor === undefined) return null;
      if (op === 'L') {
        const f = parseForwardSpec(valor);
        if (f) forwards.push(f);
      }
      if (op === 'F') configFile = valor;
      break;
    }
  }
  return null;
}

/** `ssh -G <destino>`: as linhas `localforward 14720 [127.0.0.1]:4720` (ou `[localhost]:14720 …`). */
export function parseSshG(out: string): Forward[] {
  const fs: Forward[] = [];
  for (const m of out.matchAll(/^localforward\s+(?:\[[^\]]*\]:)?(\d+)\s+\[?([^\]\s]+?)\]?:(\d+)\s*$/gim)) {
    fs.push({ localPort: Number(m[1]), remoteHost: m[2], remotePort: Number(m[3]) });
  }
  return fs;
}

const desde = (agora: number, a: PsArgsRow) => (a.elapsedSec === null ? null : new Date(agora - a.elapsedSec * 1000).toISOString());

// ---------------------------------------------------------------------------------------------

export class DarwinCollector extends PlatformCollector {
  protected readonly platform = 'darwin' as const;

  protected async readOsName(): Promise<string | null> {
    const v = (await this.run('sw_vers', ['-productVersion']))?.trim();
    return v ? `macOS ${v}` : null;
  }

  protected async memory(): Promise<MemoryReading> {
    const { os } = this.deps;
    const [vm, swap, pressao] = await Promise.all([
      this.run('vm_stat', []),
      this.run('sysctl', ['vm.swapusage']),
      this.run('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']),
    ]);
    const lido = vm ? parseVmStat(vm) : null;
    const total = os.totalmem();
    const usada = lido ? usedFromVmStat(lido) : null;
    const s = swap ? parseSwapUsage(swap) : null;
    return {
      totalBytes: total,
      usedBytes: Math.min(total, usada ?? total - os.freemem()),
      swapTotalBytes: s?.totalBytes ?? null,
      swapUsedBytes: s?.usedBytes ?? null,
      pressure: pressao ? parsePressureLevel(pressao) : null,
    };
  }

  protected async gpu(): Promise<GpuReading | null> {
    const out = await this.run('ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator']);
    return out ? parseIoregGpu(out) : null;
  }

  protected async netCounters(): Promise<Omit<NetCounters, 'atMs'> | null> {
    const rota = await this.run('route', ['-n', 'get', 'default']);
    const iface = rota ? parseRouteDefault(rota) : null;
    if (!iface) return null;
    const out = await this.run('netstat', ['-ibn']);
    const c = out ? parseNetstatIbn(out, iface) : null;
    return c ? { interface: iface, ...c } : null;
  }

  protected async processes(): Promise<ProcessSnapshot | null> {
    const [stats, args] = await Promise.all([this.run('ps', ['-axo', 'pid=,pcpu=,rss=,comm=']), this.run('ps', ['-axo', 'pid=,etime=,args='])]);
    if (stats === null) return null;
    return { stats: parsePsStats(stats), args: args ? parsePsArgs(args) : [] };
  }

  protected async listeningPorts(): Promise<ListeningPort[] | null> {
    const out = await this.run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN']);
    return out === null ? null : parseLsofListen(out);
  }

  /**
   * Cada `ssh` cliente com encaminhamento: os `-L` da linha de comando ou, sem eles, os
   * `LocalForward` do `ssh -G`. A porta fica com o `ssh` que a escuta (dois `ssh` para o mesmo
   * destino pegam a mesma configuração, e só o primeiro consegue a porta); o estado:
   * - escutada por um `ssh` (este, ou o mestre do ControlMaster): a sonda diz `up` ou `idle`;
   * - escutada por outro processo: `busy`;
   * - ninguém escuta: `down`.
   */
  protected async tunnels(ps: ProcessSnapshot | null, ports: ListeningPort[] | null): Promise<TunnelReading[] | null> {
    if (!ps) return null;
    const agora = this.now();
    const candidatos: { row: PsArgsRow; cmd: SshCommand }[] = [];
    for (const row of ps.args) {
      const cmd = parseSshArgs(row.args);
      if (!cmd) continue;
      if (cmd.forwards.length === 0) {
        const g = await this.run('ssh', [...(cmd.configFile ? ['-F', cmd.configFile] : []), '-G', cmd.destination]);
        cmd.forwards = g ? parseSshG(g) : [];
      }
      if (cmd.forwards.length > 0) candidatos.push({ row, cmd });
    }
    const escuta = new Map<number, ListeningPort>();
    for (const p of ports ?? []) if (!escuta.has(p.port) || p.process === 'ssh') escuta.set(p.port, p);
    const dono = new Map<number, number>();
    for (const { row, cmd } of candidatos) {
      for (const f of cmd.forwards) {
        // Quem escuta a porta fica com ela; senão, o primeiro que a pede.
        if (escuta.get(f.localPort)?.pid === row.pid) dono.set(f.localPort, row.pid);
        else if (!dono.has(f.localPort)) dono.set(f.localPort, row.pid);
      }
    }

    const tunnels: TunnelReading[] = [];
    for (const { row, cmd } of candidatos) {
      const fs = cmd.forwards.filter((f) => dono.get(f.localPort) === row.pid);
      if (fs.length === 0) continue;
      const portas = await Promise.all(fs.map((f) => this.tunnelPort(f, escuta.get(f.localPort) ?? null)));
      tunnels.push({ pid: row.pid, destination: cmd.destination, since: desde(agora, row), ports: portas });
    }
    return tunnels;
  }

  private async tunnelPort(f: Forward, quem: ListeningPort | null): Promise<TunnelPort> {
    const base = { localPort: f.localPort, remoteHost: f.remoteHost, remotePort: f.remotePort };
    // Sem a lista de portas (lsof falhou), a sonda decide sozinha.
    if (quem && quem.process !== 'ssh') return { ...base, state: 'busy', heldBy: quem.process };
    const r = await this.deps.probe(f.localPort).catch(() => 'refused' as const);
    return { ...base, state: r === 'open' ? 'up' : r === 'closed' ? 'idle' : 'down', heldBy: null };
  }
}
