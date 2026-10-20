// As dependências dos coletores nos testes: o executor devolve as saídas gravadas em
// test/fixtures/telemetry, a leitura de arquivo idem, o relógio anda só pela espera, e cada chamada
// fica registrada. Nada chama o sistema.
import { readFileSync } from 'node:fs';
import { DOCKER_DF_ARGS, DOCKER_PS_ARGS } from '../../src/telemetry/adapters/common.ts';
import type { CollectorDeps, CpuTimes, PortProbe, StatFs } from '../../src/telemetry/ports.ts';

const DIR = new URL('../fixtures/telemetry/', import.meta.url);
export const fixture = (name: string) => readFileSync(new URL(name, DIR), 'utf8');

/** Saída por chamada (`comando args…`); uma lista vale em sequência, repetindo a última. */
export type Recorded = Record<string, string | string[] | null>;

export const DARWIN_COMMANDS: Recorded = {
  'sw_vers -productVersion': fixture('darwin/sw_vers.txt'),
  vm_stat: fixture('darwin/vm_stat.txt'),
  'sysctl vm.swapusage': fixture('darwin/sysctl-swapusage.txt'),
  'sysctl -n kern.memorystatus_vm_pressure_level': fixture('darwin/sysctl-pressure.txt'),
  'ioreg -r -d 1 -w 0 -c IOAccelerator': fixture('darwin/ioreg-accelerator.txt'),
  'route -n get default': fixture('darwin/route-default.txt'),
  'netstat -ibn': [fixture('darwin/netstat-ibn-1.txt'), fixture('darwin/netstat-ibn-2.txt')],
  'df -P': fixture('darwin/df-P.txt'),
  'ps -axo pid=,pcpu=,rss=,comm=': fixture('darwin/ps-stats.txt'),
  'ps -axo pid=,etime=,args=': fixture('darwin/ps-args.txt'),
  'lsof -nP -iTCP -sTCP:LISTEN': fixture('darwin/lsof-listen.txt'),
  'ssh -G ws-exemplo': fixture('darwin/ssh-G-ws-exemplo.txt'),
  [['docker', ...DOCKER_PS_ARGS].join(' ')]: fixture('docker-ps.txt'),
  [['docker', ...DOCKER_DF_ARGS].join(' ')]: fixture('docker-system-df.txt'),
};

export const LINUX_COMMANDS: Recorded = {
  'nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits': fixture('linux/nvidia-smi.txt'),
  'df -P': fixture('linux/df-P.txt'),
  'ps -eo pid=,pcpu=,rss=,comm=': fixture('linux/ps-stats.txt'),
  'ps -eo pid=,etime=,args=': fixture('linux/ps-args.txt'),
  'ss -ltnp': fixture('linux/ss-ltnp.txt'),
};

export const LINUX_FILES: Recorded = {
  '/etc/os-release': fixture('linux/os-release.txt'),
  '/proc/meminfo': fixture('linux/meminfo.txt'),
  '/proc/net/route': fixture('linux/proc-net-route.txt'),
  '/proc/net/dev': [fixture('linux/proc-net-dev-1.txt'), fixture('linux/proc-net-dev-2.txt')],
};

export const T0 = Date.parse('2026-11-02T12:00:00.000Z');

const tempos = (user: number, sys: number, idle: number): CpuTimes => ({ user, nice: 0, sys, idle, irq: 0 });

export interface Call {
  command: string;
  args: readonly string[];
  timeoutMs: number | undefined;
}

export function fixtureDeps(opts: {
  commands?: Recorded;
  files?: Recorded;
  statfs?: StatFs;
  probe?: PortProbe;
  cores?: number;
  hostname?: string;
}) {
  const calls: Call[] = [];
  const vezes = new Map<string, number>();
  const pegar = (mapa: Recorded, k: string): string | null => {
    const v = mapa[k];
    if (v === undefined || v === null) return null;
    if (!Array.isArray(v)) return v;
    const i = vezes.get(k) ?? 0;
    vezes.set(k, i + 1);
    return v[Math.min(i, v.length - 1)];
  };
  let t = T0 - 1000;
  let cpuCalls = 0;
  const cores = opts.cores ?? 12;
  const deps: CollectorDeps = {
    run: async (command, args, o) => {
      calls.push({ command, args, timeoutMs: o?.timeoutMs });
      return pegar(opts.commands ?? {}, [command, ...args].join(' '));
    },
    readFile: async (path) => pegar(opts.files ?? {}, path),
    statfs: opts.statfs ?? (async () => null),
    probe: opts.probe ?? (async () => 'refused'),
    os: {
      hostname: () => opts.hostname ?? 'mac-exemplo',
      arch: () => 'arm64',
      uptime: () => 3600.4,
      totalmem: () => 38_654_705_664,
      freemem: () => 1_000_000_000,
      loadavg: () => [4.111, 3.8, 3.2],
      // A primeira medida e as seguintes: metade do tempo ocupado entre elas (50%).
      cpus: () => Array.from({ length: cores }, () => ({ model: 'CPU Exemplo', times: cpuCalls++ < cores ? tempos(1000, 500, 8500) : tempos(1200, 600, 8800) })),
    },
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  };
  return { deps, calls };
}
