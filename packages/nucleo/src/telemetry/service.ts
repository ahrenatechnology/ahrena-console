// What the routes return (#175): the list of machines and the telemetry of one of them.
//
// Each machine comes from a `MachineEntry` with its own `state()`: `local` (this machine), the
// simulator's workstation in `--demo`, and each remote machine of `machines.json` (#176, remote.ts),
// whose samples are in the same `TelemetryStore`, under its id. The telemetry of a remote that is
// down is still served: its newest stored reading, with its age in `lastReadAt`.

import type { AlertTracker } from './alerts.ts';
import {
  LOCAL_MACHINE_ID,
  TELEMETRY_VERSION,
  type Alert,
  type ConnectionStatus,
  type MachineState,
  type MachineSummary,
  type ReconnectStatus,
  type TelemetryReading,
  type TelemetrySeries,
  type UnreachableReason,
  type WindowHours,
} from './model.ts';
import type { TelemetryStore } from './ports.ts';
import { buildSeries } from './series.ts';

/** A machine's state with what explains it (#176). */
export interface MachineStatus {
  state: MachineState;
  reason: UnreachableReason | null;
  version: number | null;
}

export interface MachineEntry {
  id: string;
  /** The name in the sidebar and the tray. */
  label: string;
  state(): MachineState;
  /** The reason and version behind `state()`; without it, no reason and this núcleo's version. */
  status?(): MachineStatus;
  /** The local port the tunnel forwards, for a remote machine. */
  port?: number;
  /** A remote machine's reconnect (#244); without it, `null`. */
  reconnect?(): ReconnectStatus | null;
  /** A remote machine's connection (#278); without it, the summary has no `connection`. */
  connection?: () => Promise<ConnectionStatus | null>;
}

/** This machine: the núcleo answering is its own, so it is always connected. */
export const localMachine = (label = 'Esta máquina'): MachineEntry => ({ id: LOCAL_MACHINE_ID, label, state: () => 'connected' });

export interface TelemetryResponse {
  version: number;
  machine: MachineSummary;
  hours: WindowHours;
  /** The newest reading; `null` before the first sample. */
  current: TelemetryReading | null;
  series: TelemetrySeries;
  alerts: Alert[];
}

export interface TelemetryServiceOptions {
  store: TelemetryStore;
  tracker: AlertTracker;
  /** A list, or a function for the list that follows machines.json live (#244). */
  machines: readonly MachineEntry[] | (() => readonly MachineEntry[]);
  now?: () => number;
}

export class TelemetryService {
  private readonly o: TelemetryServiceOptions;

  constructor(options: TelemetryServiceOptions) {
    this.o = options;
  }

  private list(): readonly MachineEntry[] {
    const m = this.o.machines;
    return typeof m === 'function' ? m() : m;
  }

  has(machineId: string): boolean {
    return this.list().some((m) => m.id === machineId);
  }

  private async summary(m: MachineEntry, latest?: TelemetryReading | null): Promise<MachineSummary> {
    const r = latest === undefined ? await this.o.store.latest(m.id) : latest;
    const s = m.status?.() ?? { state: m.state(), reason: null, version: TELEMETRY_VERSION };
    return {
      id: m.id,
      label: m.label,
      state: s.state,
      reason: s.reason,
      version: s.version,
      port: m.port ?? null,
      lastReadAt: r?.takenAt ?? null,
      alerts: this.o.tracker.active(m.id).length,
      reconnect: m.reconnect?.() ?? null,
      ...(m.connection ? { connection: await m.connection().catch(() => null) } : {}),
    };
  }

  /** This machine first, then the remote ones in configuration order. */
  async machines(): Promise<MachineSummary[]> {
    return Promise.all(this.list().map((m) => this.summary(m)));
  }

  /** `null` when the machine does not exist. */
  async telemetry(machineId: string, hours: WindowHours): Promise<TelemetryResponse | null> {
    const m = this.list().find((x) => x.id === machineId);
    if (!m) return null;
    const now = (this.o.now ?? Date.now)();
    const from = now - hours * 3_600_000;
    const [current, points] = await Promise.all([this.o.store.latest(m.id), this.o.store.listPoints(m.id, from)]);
    return {
      version: TELEMETRY_VERSION,
      machine: await this.summary(m, current),
      hours,
      current,
      series: buildSeries(points, from, now),
      alerts: this.o.tracker.active(m.id),
    };
  }
}
