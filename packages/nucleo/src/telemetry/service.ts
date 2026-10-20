// What the routes return (#175): the list of machines and the telemetry of one of them.
//
// Today only `local` (this machine) is really measured. The shape is already #176's: each machine
// comes from a `MachineEntry` with its own `state()`; a remote machine will come in with the state
// of the tunnel and of its núcleo, and its samples in the same `TelemetryStore`, under its id.

import type { AlertTracker } from './alerts.ts';
import {
  LOCAL_MACHINE_ID,
  TELEMETRY_VERSION,
  type Alert,
  type MachineState,
  type MachineSummary,
  type TelemetryReading,
  type TelemetrySeries,
  type WindowHours,
} from './model.ts';
import type { TelemetryStore } from './ports.ts';
import { buildSeries } from './series.ts';

export interface MachineEntry {
  id: string;
  /** The name in the sidebar and the tray. */
  label: string;
  state(): MachineState;
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
  machines: readonly MachineEntry[];
  now?: () => number;
}

export class TelemetryService {
  private readonly o: TelemetryServiceOptions;

  constructor(options: TelemetryServiceOptions) {
    this.o = options;
  }

  has(machineId: string): boolean {
    return this.o.machines.some((m) => m.id === machineId);
  }

  private async summary(m: MachineEntry, latest?: TelemetryReading | null): Promise<MachineSummary> {
    const r = latest === undefined ? await this.o.store.latest(m.id) : latest;
    return { id: m.id, label: m.label, state: m.state(), lastReadAt: r?.takenAt ?? null, alerts: this.o.tracker.active(m.id).length };
  }

  /** This machine first, then the remote ones in configuration order. */
  async machines(): Promise<MachineSummary[]> {
    return Promise.all(this.o.machines.map((m) => this.summary(m)));
  }

  /** `null` when the machine does not exist. */
  async telemetry(machineId: string, hours: WindowHours): Promise<TelemetryResponse | null> {
    const m = this.o.machines.find((x) => x.id === machineId);
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
