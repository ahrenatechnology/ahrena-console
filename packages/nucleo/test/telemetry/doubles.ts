// Dublês das portas da telemetria para os testes dos casos de uso: um armazenamento em memória e um
// coletor que devolve as leituras dadas, na ordem.
import { samplePointOf, type SamplePoint, type TelemetryReading } from '../../src/telemetry/model.ts';
import type { TelemetryCollector, TelemetryStore } from '../../src/telemetry/ports.ts';

export class MemoryTelemetryStore implements TelemetryStore {
  readonly rows = new Map<string, TelemetryReading[]>();

  async putSample(machineId: string, reading: TelemetryReading, retentionMs: number): Promise<void> {
    const at = Date.parse(reading.takenAt);
    const l = (this.rows.get(machineId) ?? []).filter((r) => r.takenAt !== reading.takenAt && Date.parse(r.takenAt) >= at - retentionMs);
    l.push(reading);
    l.sort((a, b) => Date.parse(a.takenAt) - Date.parse(b.takenAt));
    this.rows.set(machineId, l);
  }

  async listPoints(machineId: string, sinceMs: number): Promise<SamplePoint[]> {
    return (this.rows.get(machineId) ?? []).map(samplePointOf).filter((p) => p.takenAt >= sinceMs);
  }

  async latest(machineId: string): Promise<TelemetryReading | null> {
    return this.rows.get(machineId)?.at(-1) ?? null;
  }
}

export class ScriptedCollector implements TelemetryCollector {
  calls = 0;
  private readonly readings: (TelemetryReading | Error)[];
  constructor(readings: (TelemetryReading | Error)[]) {
    this.readings = readings;
  }
  async collect(): Promise<TelemetryReading> {
    const r = this.readings[Math.min(this.calls++, this.readings.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  }
}
