// As leituras que as rotas devolvem (#175): a lista de máquinas e a telemetria de uma delas.
//
// Hoje só `local` (esta máquina) mede de verdade. A forma já é a da #176: cada máquina vem de um
// `MachineEntry` com o próprio `state()`; a remota vai entrar com o estado do túnel e do núcleo de lá,
// e as amostras dela no mesmo `TelemetryStore`, pelo id dela.

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
  /** O nome na barra lateral e na bandeja. */
  label: string;
  state(): MachineState;
}

/** Esta máquina: o núcleo que responde é o dela, então está sempre conectada. */
export const localMachine = (label = 'Esta máquina'): MachineEntry => ({ id: LOCAL_MACHINE_ID, label, state: () => 'connected' });

export interface TelemetryResponse {
  version: number;
  machine: MachineSummary;
  hours: WindowHours;
  /** A leitura mais nova; `null` antes da primeira amostra. */
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

  /** Esta máquina primeiro, depois as remotas na ordem da configuração. */
  async machines(): Promise<MachineSummary[]> {
    return Promise.all(this.o.machines.map((m) => this.summary(m)));
  }

  /** `null` quando a máquina não existe. */
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
