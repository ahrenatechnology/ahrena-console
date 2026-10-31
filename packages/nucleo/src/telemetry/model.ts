// Machine telemetry (#175, decision 0008): what the núcleo measures about its own machine every 30 s.
//
// A reading (`TelemetryReading`) is a snapshot of the machine at one moment. Any group that depends
// on a command may be missing: a command that does not exist, fails or times out becomes `null` in
// the group (or the field), never a route error. Keys are in English (the repository rule for new
// code); the text the screen shows (the alert messages) is in pt-BR.

/** Changes when the shape of the reading changes in a way readers need to know about (#176 compares it). */
export const TELEMETRY_VERSION = 1;

/** One sample every 30 s while the núcleo is up. */
export const SAMPLE_INTERVAL_MS = 30_000;
/** 12 h of samples in SQLite, pruned on write. */
export const RETENTION_MS = 12 * 60 * 60 * 1000;
/** The windows the screen asks for: 1 h by default, 12 h on request. */
export const WINDOW_HOURS = [1, 12] as const;
export type WindowHours = (typeof WINDOW_HOURS)[number];

/** A machine's state for the sidebar and the tray. */
export const MACHINE_STATES = ['connected', 'unreachable', 'not-configured', 'incompatible-version'] as const;
export type MachineState = (typeof MACHINE_STATES)[number];

/**
 * Why a remote machine is `unreachable` (#176, decision 0008 section 3):
 * - `port-closed`: the local port the tunnel forwards refuses the connection (the tunnel is down);
 * - `no-response`: the port accepts, but the núcleo over there does not answer HTTP in time, closes
 *   at once or answers with an HTTP error other than 404 (the tunnel is up, the núcleo is not).
 *   A 200 without a telemetry `version`, or a 404, is `incompatible-version` instead.
 */
export const UNREACHABLE_REASONS = ['port-closed', 'no-response', 'owner-auth-required'] as const;
export type UnreachableReason = (typeof UNREACHABLE_REASONS)[number];

/** This machine. Remote machines use the `id` from `~/.ahrena-console/machines.json` (#176). */
export const LOCAL_MACHINE_ID = 'local';
/** Machine id in the URL and in the database. */
export const MACHINE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface HostInfo {
  hostname: string;
  platform: 'darwin' | 'linux' | 'simulated';
  /** "macOS 26.1", "Ubuntu 24.04.1 LTS"; `null` when it could not be read. */
  os: string | null;
  arch: string;
  uptimeSec: number;
}

export interface CpuReading {
  cores: number;
  model: string | null;
  /** Usage across all cores since the previous sample, 0 to 100. */
  usedPct: number | null;
  /** 1, 5 and 15 min load averages, to compare against `cores`. */
  load: { one: number; five: number; fifteen: number };
}

export type MemoryPressure = 'normal' | 'warning' | 'critical';

export interface MemoryReading {
  totalBytes: number;
  usedBytes: number;
  swapTotalBytes: number | null;
  swapUsedBytes: number | null;
  /** Mac only (`kern.memorystatus_vm_pressure_level`). */
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
  /** The interface of the default route. */
  interface: string;
  /** Between this sample and the previous one; `null` on the first one or when the counter went back. */
  rxBytesPerSec: number | null;
  txBytesPerSec: number | null;
  /** Since boot. */
  rxBytesTotal: number;
  txBytesTotal: number;
}

export interface ProcessGroup {
  count: number;
  cpuPct: number;
  memoryBytes: number;
}

export interface ClaudeProcesses {
  /** CLI and Claude Desktop added together. */
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
  /** The `com.docker.compose.project` label. */
  name: string;
  running: number;
  stopped: number;
  /** Ports published on the host, sorted. */
  ports: number[];
}

export interface DockerSpace {
  /** `Images`, `Containers`, `Local Volumes`, `Build Cache`, as `docker system df` names them. */
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
  /** `null` when `docker system df` did not answer in time. */
  space: DockerSpace[] | null;
}

/** `all`: every interface (`*`, `0.0.0.0`, `[::]`); `loopback`: this machine only; `address`: one given address. */
export type ListenInterface = 'all' | 'loopback' | 'address';

export interface ListeningPort {
  port: number;
  interface: ListenInterface;
  /** The address when `interface` is `address`. */
  address: string | null;
  process: string | null;
  pid: number | null;
}

/**
 * - `up`: the tunnel forwards and the other side answers (the connection stays open);
 * - `idle`: forwarded, but the connection opens and closes at once (nothing listens over there);
 * - `busy`: another process on this Mac holds the port;
 * - `down`: nothing listens on the port here.
 */
export type TunnelPortState = 'up' | 'idle' | 'busy' | 'down';

export interface TunnelPort {
  localPort: number;
  remoteHost: string;
  remotePort: number;
  state: TunnelPortState;
  /** Who holds the port when `busy`. */
  heldBy: string | null;
}

export interface TunnelReading {
  pid: number;
  /** The `ssh` destination as written on the command line (the `~/.ssh/config` alias). */
  destination: string;
  /** When the process started; `null` when `ps` did not say. */
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
  /** The six using the most CPU. */
  topProcesses: TopProcess[] | null;
  /** `null` without `docker` on the PATH or without the daemon. */
  docker: DockerReading | null;
  ports: ListeningPort[] | null;
  /** Mac only; `null` where it does not apply. */
  tunnels: TunnelReading[] | null;
  /** Where the machine runs, read by its own núcleo (#278, decision 0013 section 5); absent from older readings. */
  placement?: Placement;
  /** The terminal sessions (#350); `null` when `ps` did not answer, absent from older readings. */
  terminals?: TerminalsReading | null;
}

// ---------------------------------------------------------------------------------------------
// Terminal sessions (#350)

/** Why this núcleo never signals a process: the tunnel's `sshd`, the núcleo itself (and what runs it), another user. */
export type TerminalProtection = 'tunnel' | 'core' | 'other-user';
/** `idle`: only the prompt; `running`: a command in the foreground; `stopped`: that command was suspended (Ctrl-Z). */
export type TerminalState = 'idle' | 'running' | 'stopped';

export interface TerminalSession {
  /** The terminal as `ps` names it: `pts/0` on Linux, `ttys003` on the Mac. */
  tty: string;
  /** The same, safe in a URL path: `pts-0`, `ttys003`. */
  id: string;
  user: string;
  /** Only the user's own sessions can be acted on. */
  own: boolean;
  /** What holds the terminal: the `sshd` of an ssh connection, a terminal app on the Mac, or nothing known. */
  connection: { kind: 'sshd' | 'app' | 'local'; pid: number | null; label: string | null; since: string | null; ttys: string[]; protection: TerminalProtection | null };
  shell: { pid: number; args: string } | null;
  /** The foreground command; `null` when `idle`. `pid` is the process group leader the actions are checked against. */
  foreground: { pid: number; pgid: number; args: string; ageSec: number; processes: number; protection: TerminalProtection | null } | null;
  /** What "Encerrar a sessão" signals: the connection's `sshd`, or the shell where there is no `sshd`. */
  end: { pid: number | null; protection: TerminalProtection | null };
  state: TerminalState;
  /** The foreground command passed the limit without being a known interactive one, or is a Claude scratchpad script. */
  stuck: boolean;
  /** The Claude session whose scratchpad the command runs from, when the path says it. */
  claudeSessionId: string | null;
}

export interface TerminalsReading {
  sessions: TerminalSession[];
  /** The limit in seconds that makes a command "presa". */
  stuckAfterSec: number;
  /** This núcleo accepts actions that come through the tunnel (`--accept-remote-actions`); the Mac's screen offers "Copiar comando" when not. */
  remoteActions: boolean;
}

// ---------------------------------------------------------------------------------------------
// Placement (#278, decision 0013 section 5)

export const PLACEMENT_PROVIDERS = ['aws', 'gcp', 'azure', 'unknown'] as const;
export type PlacementProvider = (typeof PLACEMENT_PROVIDERS)[number];
export const PLACEMENT_SOURCES = ['instance-metadata', 'ssm-registration', 'dmi'] as const;
export type PlacementSource = (typeof PLACEMENT_SOURCES)[number];

/**
 * Where the machine runs, from its instance metadata, its SSM agent registration or its DMI, without
 * credentials. `kind`: the instance type from the metadata, `managed-instance` from the SSM
 * registration, `null` from the DMI. Everything `null` (and `provider: 'unknown'`) when nothing answered.
 */
export interface Placement {
  provider: PlacementProvider;
  kind: string | null;
  region: string | null;
  zone: string | null;
  instanceId: string | null;
  source: PlacementSource | null;
  /** When the núcleo read it. */
  readAt: string | null;
}

// ---------------------------------------------------------------------------------------------
// Alerts

/** `machine-unreachable` (#176): a remote machine the núcleo cannot read; computed on this Mac, not over there. */
export type AlertKind = 'load-high' | 'volume-full' | 'port-exposed' | 'tunnel-busy' | 'machine-unreachable' | 'terminal-stuck';
export type AlertLevel = 'error' | 'warning';

export interface Alert {
  /** Stable while the condition lasts: `volume-full:/`, `port-exposed:5432`, `tunnel-busy:18080`. */
  id: string;
  kind: AlertKind;
  level: AlertLevel;
  /** Screen text, in pt-BR. */
  message: string;
  detail: string | null;
  /** Since when the condition holds. */
  since: string;
}

/** Load above the core count for this long becomes an alert. */
export const LOAD_HIGH_FOR_MS = 5 * 60 * 1000;
/** A volume above this becomes an alert. */
export const VOLUME_FULL_PCT = 85;

// ---------------------------------------------------------------------------------------------
// Samples and series

/** What the series and the alerts need from each sample, without opening the whole reading. */
export interface SamplePoint {
  /** ms since the epoch. */
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

/** The screen's series, columns parallel to `at`. */
export interface TelemetrySeries {
  /** Samples (or the mean of each bucket, at 12 h), oldest to newest. */
  at: string[];
  cpuUsedPct: (number | null)[];
  load1: (number | null)[];
  memoryUsedBytes: (number | null)[];
  swapUsedBytes: (number | null)[];
  rxBytesPerSec: (number | null)[];
  txBytesPerSec: (number | null)[];
  gpuUsedPct: (number | null)[];
}

/** The cap on points per series: 1 h fits whole (120); 12 h becomes 2 min buckets. */
export const MAX_SERIES_POINTS = 360;

// ---------------------------------------------------------------------------------------------
// Machines

/** Where a remote machine's reconnect is (#244, decision 0012 section 4). */
export const RECONNECT_STATES = ['idle', 'running', 'succeeded', 'failed', 'timed-out', 'canceled'] as const;
export type ReconnectState = (typeof RECONNECT_STATES)[number];
/** `ui` = the same-origin /ui; `local` = a no-Origin loopback client (the tray). */
export type ReconnectStarter = 'ui' | 'local';

/** A remote machine's reconnect, as `GET /api/machines` serves it. Never any command output. */
export interface ReconnectStatus {
  configured: boolean;
  /** The list from machines.json, for the screen to show what runs; `null` without a command. */
  command: string[] | null;
  timeoutSeconds: number | null;
  state: ReconnectState;
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
  startedBy: ReconnectStarter | null;
  /** Where the output went (`reconnect.log` in the installation's data folder). */
  logFile: string | null;
}

export interface MachineSummary {
  id: string;
  label: string;
  state: MachineState;
  /** Only when `state` is `unreachable`; `null` otherwise (and before a remote's first read). */
  reason: UnreachableReason | null;
  /** The telemetry version the machine answers with; `null` while unknown (never read, or not reported). */
  version: number | null;
  /** The local port the tunnel forwards (`machines.json`); `null` for this machine and the simulated one. */
  port: number | null;
  /** The `takenAt` of the newest stored reading: its age, also while the machine is down. */
  lastReadAt: string | null;
  alerts: number;
  /** The reconnect of a remote machine (#244); `null` for this machine and the demo's simulated one. */
  reconnect: ReconnectStatus | null;
  /** The connection of a remote machine (#278); only on remote machines. */
  connection?: ConnectionStatus | null;
}

// ---------------------------------------------------------------------------------------------
// The connection of a remote machine (#278, decision 0013 section 4)

export const CONNECTION_STATES = ['up', 'down', 'starting', 'stopping', 'failing', 'stopped'] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];

/** Why the connection is down, a CLOSED list in this order of precedence (decision 0013 section 4). */
export const CONNECTION_REASONS = ['sso-expired', 'port-busy', 'core-not-answering', 'ssm-agent-offline', 'host-unknown', 'key-refused', 'exit-code'] as const;
export type ConnectionReason = (typeof CONNECTION_REASONS)[number];

export const CONNECTION_JOB_KINDS = ['start', 'stop', 'reconnect', 'login-and-start'] as const;
export type ConnectionJobKind = (typeof CONNECTION_JOB_KINDS)[number];
export type ConnectionStep = 'login' | 'stop' | 'start' | 'read';
export type ConnectionJobState = 'running' | 'succeeded' | 'failed' | 'timed-out' | 'canceled';

/** `not-found`: the profile is not in this Mac's ~/.aws/config; `unavailable`: the núcleo runs without the connector (the demo). */
export type CloudLinkState = 'valid' | 'expiring' | 'expired' | 'never' | 'unknown' | 'not-found' | 'unavailable';

export interface ConnectionCloud {
  connector: 'aws';
  profile: string;
  /** The SSO session the profile uses; `null` when the profile is not found. */
  session: string | null;
  state: CloudLinkState;
  expiresAt: string | null;
}

export interface ConnectionError {
  reason: ConnectionReason;
  at: string;
  /** The failed command's exit code (`null` when a signal or a timeout ended it, or the reason is a probe's). */
  exitCode: number | null;
  /** The process holding the port, for `port-busy` when the probe saw it. */
  holder: string | null;
}

/** The job running (or the last one), with its steps in order. */
export interface ConnectionJob {
  kind: ConnectionJobKind;
  steps: ConnectionStep[];
  /** The step running (or where it ended). */
  step: ConnectionStep;
  state: ConnectionJobState;
  startedAt: string;
  endedAt: string | null;
  stepStartedAt: string;
  /** The running step's timeout; `null` for `read`. */
  stepTimeoutSeconds: number | null;
  startedBy: ReconnectStarter;
}

/** A remote machine's connection, as `GET /api/machines` serves it. Never any command output. */
export interface ConnectionStatus {
  configured: boolean;
  state: ConnectionState;
  since: string | null;
  /** This Mac's tunnel forwarding the machine's port (matched by it), each port with its probe. */
  ports: TunnelPort[];
  cloud: ConnectionCloud | null;
  lastError: ConnectionError | null;
  actions: { start: boolean; stop: boolean; reconnect: boolean; loginAndStart: boolean };
  /** What runs, for the screen to show; `null` without a connection. */
  command: { start: string[]; stop: string[] | null; startTimeoutSeconds: number; stopTimeoutSeconds: number | null } | null;
  job: ConnectionJob | null;
  logFile: string | null;
}

export function isWindowHours(n: number): n is WindowHours {
  return (WINDOW_HOURS as readonly number[]).includes(n);
}
