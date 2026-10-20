// The telemetry ports (#175). The rest of the núcleo depends only on these interfaces:
//
// - `TelemetryCollector`: measures the machine. One adapter per platform (adapters/darwin.ts,
//   adapters/linux.ts) plus the simulator's; each receives the command runner, the file reader,
//   the `node:os` facts and the port probe, so tests never call the system.
// - `TelemetryStore`: keeps the samples (adapters/sqlite.ts), with the same rules as the storage
//   port (everything async, whole-record writes, queries by access pattern).

import type { SamplePoint, TelemetryReading } from './model.ts';

export interface TelemetryCollector {
  /** A reading now. Never rejects because a command is missing: that group comes out `null`. */
  collect(): Promise<TelemetryReading>;
}

export interface TelemetryStore {
  /**
   * Writes the sample (creates or replaces it by time) and deletes the machine's samples that are
   * `retentionMs` or more older than it (12 h is 1440 samples, not 1441).
   */
  putSample(machineId: string, reading: TelemetryReading, retentionMs: number): Promise<void>;
  /** The machine's points since `sinceMs` (inclusive), oldest to newest. */
  listPoints(machineId: string, sinceMs: number): Promise<SamplePoint[]>;
  /** The machine's newest reading; `null` when there is none. */
  latest(machineId: string): Promise<TelemetryReading | null>;
}

// ---------------------------------------------------------------------------------------------
// What the collectors receive from outside

/**
 * Runs a command without a shell and returns its output. `null` when the command does not exist,
 * fails or exceeds `timeoutMs`: the field that depended on it is left absent.
 */
export type CommandRunner = (command: string, args: readonly string[], options?: { timeoutMs?: number }) => Promise<string | null>;

/** Reads a text file (the Linux `/proc`); `null` when it does not exist or cannot be read. */
export type FileReader = (path: string) => Promise<string | null>;

/** The size of a mounted file system, from `fs.statfs`. `null` when it fails. */
export type StatFs = (mount: string) => Promise<{ totalBytes: number; freeBytes: number; availableBytes: number } | null>;

/**
 * Owner and mode of a file, from `fs.stat` (follows links). `null` when it does not exist or cannot
 * be read. Used for an `ssh -F`: only a file of the user's own is passed on to `ssh -G`.
 */
export type FileOwner = (path: string) => Promise<{ uid: number; mode: number } | null>;

/**
 * Probe of a local port, for the tunnel state:
 * - `open`: connected and the connection stayed open;
 * - `closed`: connected and closed right away (`ssh` accepted and nobody was on the other side);
 * - `refused`: nothing listens here.
 */
export type PortProbe = (port: number) => Promise<'open' | 'closed' | 'refused'>;

export interface CpuTimes {
  user: number;
  nice: number;
  sys: number;
  idle: number;
  irq: number;
}

/** What `node:os` provides, injectable. */
export interface OsFacts {
  hostname(): string;
  arch(): string;
  uptime(): number;
  totalmem(): number;
  freemem(): number;
  loadavg(): number[];
  cpus(): { model: string; times: CpuTimes }[];
  /** The uid running the núcleo (`process.getuid`); `null` where there is none (Windows). */
  uid(): number | null;
}

export interface CollectorDeps {
  run: CommandRunner;
  readFile: FileReader;
  statfs: StatFs;
  fileOwner: FileOwner;
  probe: PortProbe;
  os: OsFacts;
  /** Clock, for `takenAt` and the rates. */
  now?: () => number;
  /** The wait before the first reading (CPU and network need two measurements). Nothing in tests. */
  sleep?: (ms: number) => Promise<void>;
}
