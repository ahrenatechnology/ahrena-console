// Uma leitura sintética para os testes da telemetria: nomes de exemplo, nada de máquina real.
import type { SamplePoint, TelemetryReading } from '../../src/telemetry/model.ts';

export const T0 = Date.parse('2026-11-02T12:00:00.000Z');
export const iso = (ms: number) => new Date(ms).toISOString();

export function reading(over: Partial<TelemetryReading> = {}, at = T0): TelemetryReading {
  return {
    takenAt: iso(at),
    host: { hostname: 'mac-exemplo', platform: 'darwin', os: 'macOS 26.1', arch: 'arm64', uptimeSec: 3600 },
    cpu: { cores: 12, model: 'Apple M-exemplo', usedPct: 34, load: { one: 4.1, five: 3.8, fifteen: 3.2 } },
    memory: { totalBytes: 36e9, usedBytes: 21.4e9, swapTotalBytes: 2e9, swapUsedBytes: 0.8e9, pressure: 'normal' },
    gpu: null,
    disk: { volumes: [{ mount: '/', totalBytes: 612e9, usedBytes: 232e9, freeBytes: 380e9, usedPct: 37.9 }] },
    network: { interface: 'en0', rxBytesPerSec: 2.4e6, txBytesPerSec: 310e3, rxBytesTotal: 41e9, txBytesTotal: 6e9 },
    claude: null,
    topProcesses: null,
    docker: null,
    ports: [],
    tunnels: [],
    ...over,
  };
}

export function point(at: number, over: Partial<SamplePoint> = {}): SamplePoint {
  return {
    takenAt: at,
    cpuUsedPct: 30,
    load1: 2,
    cores: 12,
    memoryUsedBytes: 20e9,
    swapUsedBytes: 1e9,
    rxBytesPerSec: 1000,
    txBytesPerSec: 500,
    gpuUsedPct: null,
    ...over,
  };
}
