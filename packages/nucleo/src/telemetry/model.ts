// Telemetria da máquina (#175, decisão 0008): o que o núcleo mede de si mesmo a cada 30 s.
//
// Uma leitura (`TelemetryReading`) é o retrato da máquina numa hora. Todo grupo que depende de um
// comando pode faltar: o comando que não existe, falha ou estoura o tempo vira `null` no grupo (ou no
// campo), nunca um erro da rota. Chaves em inglês (regra do repositório para o que é novo); o texto
// que a tela mostra (as mensagens dos alertas) é em pt-BR.

/** Muda quando a forma da leitura muda de um jeito que quem lê precisa saber (#176 compara). */
export const TELEMETRY_VERSION = 1;

/** Uma amostra a cada 30 s enquanto o núcleo está de pé. */
export const SAMPLE_INTERVAL_MS = 30_000;
/** 12 h de amostras no SQLite, podadas na escrita. */
export const RETENTION_MS = 12 * 60 * 60 * 1000;
/** As janelas que a tela pede: 1 h por padrão, 12 h a pedido. */
export const WINDOW_HOURS = [1, 12] as const;
export type WindowHours = (typeof WINDOW_HOURS)[number];

/** O estado de uma máquina para a barra lateral e a bandeja. A remota é a #176. */
export const MACHINE_STATES = ['connected', 'unreachable', 'not-configured', 'incompatible-version'] as const;
export type MachineState = (typeof MACHINE_STATES)[number];

/** Esta máquina. As remotas usam o `id` de `~/.ahrena-console/machines.json` (#176). */
export const LOCAL_MACHINE_ID = 'local';
/** Id de máquina na URL e no banco. */
export const MACHINE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface HostInfo {
  hostname: string;
  platform: 'darwin' | 'linux' | 'simulated';
  /** "macOS 26.1", "Ubuntu 24.04.1 LTS"; `null` quando não deu para ler. */
  os: string | null;
  arch: string;
  uptimeSec: number;
}

export interface CpuReading {
  cores: number;
  model: string | null;
  /** Uso de todos os núcleos desde a amostra anterior, 0 a 100. */
  usedPct: number | null;
  /** Carga média de 1, 5 e 15 min, para comparar com `cores`. */
  load: { one: number; five: number; fifteen: number };
}

export type MemoryPressure = 'normal' | 'warning' | 'critical';

export interface MemoryReading {
  totalBytes: number;
  usedBytes: number;
  swapTotalBytes: number | null;
  swapUsedBytes: number | null;
  /** Só no Mac (`kern.memorystatus_vm_pressure_level`). */
  pressure: MemoryPressure | null;
}

export interface GpuReading {
  name: string | null;
  usedPct: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
}

export interface VolumeReading {
  mount: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usedPct: number;
}

export interface NetworkReading {
  /** A interface da rota padrão. */
  interface: string;
  /** Entre esta amostra e a anterior; `null` na primeira ou quando o contador voltou. */
  rxBytesPerSec: number | null;
  txBytesPerSec: number | null;
  /** Desde o boot. */
  rxBytesTotal: number;
  txBytesTotal: number;
}

export interface ProcessGroup {
  count: number;
  cpuPct: number;
  memoryBytes: number;
}

export interface ClaudeProcesses {
  /** CLI e Claude Desktop somados. */
  processes: ProcessGroup;
  cli: ProcessGroup;
  desktop: ProcessGroup;
}

export interface TopProcess {
  pid: number;
  name: string;
  cpuPct: number;
  memoryBytes: number;
}

export interface DockerStack {
  /** O rótulo `com.docker.compose.project`. */
  name: string;
  running: number;
  stopped: number;
  /** Portas publicadas no host, em ordem. */
  ports: number[];
}

export interface DockerSpace {
  /** `Images`, `Containers`, `Local Volumes`, `Build Cache`, como o `docker system df` diz. */
  type: string;
  totalCount: number;
  active: number;
  sizeBytes: number;
  reclaimableBytes: number;
}

export interface DockerReading {
  running: number;
  stopped: number;
  stacks: DockerStack[];
  /** `null` quando o `docker system df` não respondeu a tempo. */
  space: DockerSpace[] | null;
}

/** `all`: todas as interfaces (`*`, `0.0.0.0`, `[::]`); `loopback`: só esta máquina; `address`: um endereço dado. */
export type ListenInterface = 'all' | 'loopback' | 'address';

export interface ListeningPort {
  port: number;
  interface: ListenInterface;
  /** O endereço quando `interface` é `address`. */
  address: string | null;
  process: string | null;
  pid: number | null;
}

/**
 * - `up`: o túnel encaminha e o outro lado responde (a conexão fica aberta);
 * - `idle`: encaminhada, mas a conexão abre e fecha na hora (ninguém escuta lá);
 * - `busy`: outro processo deste Mac segura a porta;
 * - `down`: nada escuta a porta aqui.
 */
export type TunnelPortState = 'up' | 'idle' | 'busy' | 'down';

export interface TunnelPort {
  localPort: number;
  remoteHost: string;
  remotePort: number;
  state: TunnelPortState;
  /** Quem segura a porta quando `busy`. */
  heldBy: string | null;
}

export interface TunnelReading {
  pid: number;
  /** O destino do `ssh`, como está na linha de comando (o apelido do `~/.ssh/config`). */
  destination: string;
  /** Hora em que o processo começou; `null` quando o `ps` não disse. */
  since: string | null;
  ports: TunnelPort[];
}

export interface TelemetryReading {
  takenAt: string;
  host: HostInfo;
  cpu: CpuReading;
  memory: MemoryReading;
  gpu: GpuReading | null;
  disk: { volumes: VolumeReading[] };
  network: NetworkReading | null;
  claude: ClaudeProcesses | null;
  /** Os seis que mais usam CPU. */
  topProcesses: TopProcess[] | null;
  /** `null` sem o `docker` no PATH ou sem o daemon. */
  docker: DockerReading | null;
  ports: ListeningPort[] | null;
  /** Só no Mac; `null` onde não se aplica. */
  tunnels: TunnelReading[] | null;
}

// ---------------------------------------------------------------------------------------------
// Alertas

export type AlertKind = 'load-high' | 'volume-full' | 'port-exposed' | 'tunnel-busy';
export type AlertLevel = 'error' | 'warning';

export interface Alert {
  /** Estável enquanto a condição dura: `volume-full:/`, `port-exposed:5432`, `tunnel-busy:18080`. */
  id: string;
  kind: AlertKind;
  level: AlertLevel;
  /** Texto da tela, em pt-BR. */
  message: string;
  detail: string | null;
  /** Desde quando a condição vale. */
  since: string;
}

/** Carga acima dos núcleos por este tempo vira alerta. */
export const LOAD_HIGH_FOR_MS = 5 * 60 * 1000;
/** Volume acima disto vira alerta. */
export const VOLUME_FULL_PCT = 85;

// ---------------------------------------------------------------------------------------------
// Amostras e séries

/** O que a série e os alertas precisam de cada amostra, sem abrir a leitura inteira. */
export interface SamplePoint {
  /** ms desde a época. */
  takenAt: number;
  cpuUsedPct: number | null;
  load1: number;
  cores: number;
  memoryUsedBytes: number;
  swapUsedBytes: number | null;
  rxBytesPerSec: number | null;
  txBytesPerSec: number | null;
  gpuUsedPct: number | null;
}

export function samplePointOf(r: TelemetryReading): SamplePoint {
  return {
    takenAt: Date.parse(r.takenAt),
    cpuUsedPct: r.cpu.usedPct,
    load1: r.cpu.load.one,
    cores: r.cpu.cores,
    memoryUsedBytes: r.memory.usedBytes,
    swapUsedBytes: r.memory.swapUsedBytes,
    rxBytesPerSec: r.network?.rxBytesPerSec ?? null,
    txBytesPerSec: r.network?.txBytesPerSec ?? null,
    gpuUsedPct: r.gpu?.usedPct ?? null,
  };
}

/** As séries da tela, colunas paralelas a `at`. */
export interface TelemetrySeries {
  /** Amostras (ou a média de cada balde, em 12 h), da mais velha para a mais nova. */
  at: string[];
  cpuUsedPct: (number | null)[];
  load1: (number | null)[];
  memoryUsedBytes: (number | null)[];
  swapUsedBytes: (number | null)[];
  rxBytesPerSec: (number | null)[];
  txBytesPerSec: (number | null)[];
  gpuUsedPct: (number | null)[];
}

/** O teto de pontos por série: 1 h cabe inteira (120); 12 h vira baldes de 2 min. */
export const MAX_SERIES_POINTS = 360;

// ---------------------------------------------------------------------------------------------
// Máquinas

export interface MachineSummary {
  id: string;
  label: string;
  state: MachineState;
  lastReadAt: string | null;
  alerts: number;
}

export function isWindowHours(n: number): n is WindowHours {
  return (WINDOW_HOURS as readonly number[]).includes(n);
}
