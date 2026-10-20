// Synthetic telemetry (#175): this machine (an example Mac) and a remote "workstation" (an example
// Linux), for `--demo`, for screens C24 and C25 and for #176 to read a remote machine without having
// one. The numbers come only from the time (waves plus noise from the instant's hash): the same time
// gives the same reading on any machine, and a 12 h window can be seeded in one go.
//
// Both profiles follow the wireframes: on the Mac, port 5432 on all interfaces and tunnel port
// 18080 busy; on the workstation, volume / above 85%, two ports on all interfaces and a load that
// goes above the 16 cores for about 15 min every 40 min (the alert enters and exits on its own).

import { RETENTION_MS, SAMPLE_INTERVAL_MS, type TelemetryReading } from '../telemetry/model.ts';
import type { TelemetryCollector, TelemetryStore } from '../telemetry/ports.ts';
import { hash32 } from './aleatorio.ts';

export type SimulatedProfile = 'local' | 'workstation';

/** The synthetic remote machine, with the `id` that `machines.json` would give it (#176). */
export const SIMULATED_WORKSTATION = { id: 'workstation', label: 'Workstation' } as const;

const GB = 1e9;
const GiB = 1024 ** 3;
const MIN = 60_000;

/** Noise in [0, 1) from the instant (every 30 s) and the metric's name. */
const noise = (name: string, at: number) => hash32(`${name}:${Math.floor(at / SAMPLE_INTERVAL_MS)}`) / 2 ** 32;
const wave = (at: number, periodMin: number, phase = 0) => Math.sin((2 * Math.PI * at) / (periodMin * MIN) + phase);
const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;

function group(count: number, cpuPct: number, memoryBytes: number) {
  return { count, cpuPct: r1(cpuPct), memoryBytes: Math.round(memoryBytes) };
}

function localReading(at: number): TelemetryReading {
  const cpu = Math.max(2, 32 + 14 * wave(at, 23) + 8 * noise('cpu', at));
  const load = 4 + 1.6 * wave(at, 23) + noise('load', at);
  const rx = Math.round(2.4e6 * (0.6 + 0.8 * noise('rx', at)));
  const tx = Math.round(310e3 * (0.6 + 0.8 * noise('tx', at)));
  const sinceBoot = (at % (7 * 86_400_000)) / 1000;
  const cli = group(4, 11.2 + 3 * noise('cli', at), 1.4 * GB);
  const desktop = group(7, 6.8 + 2 * noise('desk', at), 1.2 * GB);
  return {
    takenAt: new Date(at).toISOString(),
    host: { hostname: 'mac-exemplo', platform: 'simulated', os: 'macOS 26.1', arch: 'arm64', uptimeSec: Math.round(3 * 86_400 + sinceBoot) },
    cpu: { cores: 12, model: 'Apple M-exemplo', usedPct: r1(Math.min(100, cpu)), load: { one: r2(load), five: r2(load * 0.95), fifteen: r2(load * 0.85) } },
    memory: { totalBytes: 36 * GiB, usedBytes: Math.round((21.4 + 1.2 * wave(at, 90)) * GB), swapTotalBytes: 2 * GiB, swapUsedBytes: Math.round(0.8 * GB), pressure: 'normal' },
    gpu: { name: 'Apple M-exemplo', usedPct: Math.round(8 + 6 * noise('gpu', at)), memoryUsedBytes: Math.round(1.6 * GB), memoryTotalBytes: null },
    disk: {
      volumes: [
        { mount: '/', totalBytes: 612 * GB, usedBytes: 232 * GB, freeBytes: 380 * GB, usedPct: 37.9 },
        { mount: '/Volumes/Dados', totalBytes: 2000 * GB, usedBytes: 900 * GB, freeBytes: 1100 * GB, usedPct: 45 },
      ],
    },
    network: { interface: 'en0', rxBytesPerSec: rx, txBytesPerSec: tx, rxBytesTotal: Math.round(41 * GB + sinceBoot * 1e5), txBytesTotal: Math.round(6 * GB + sinceBoot * 1.5e4) },
    claude: { processes: group(cli.count + desktop.count, cli.cpuPct + desktop.cpuPct, cli.memoryBytes + desktop.memoryBytes), cli, desktop },
    topProcesses: [
      { pid: 401, name: 'node', cpuPct: 14, memoryBytes: 420e6 },
      { pid: 402, name: 'claude', cpuPct: 6, memoryBytes: 310e6 },
      { pid: 420, name: 'com.apple.WebKit.WebContent', cpuPct: 4, memoryBytes: 210e6 },
      { pid: 470, name: 'Code Helper', cpuPct: 3, memoryBytes: 180e6 },
      { pid: 430, name: 'ssh', cpuPct: 1, memoryBytes: 9e6 },
      { pid: 440, name: 'mds', cpuPct: 1, memoryBytes: 50e6 },
    ],
    docker: null,
    ports: [
      { port: 3000, interface: 'loopback', address: null, process: 'node', pid: 480 },
      { port: 4720, interface: 'loopback', address: null, process: 'node', pid: 401 },
      { port: 5432, interface: 'all', address: null, process: 'postgres', pid: 450 },
      { port: 13000, interface: 'loopback', address: null, process: 'ssh', pid: 430 },
      { port: 14720, interface: 'loopback', address: null, process: 'ssh', pid: 430 },
      { port: 15173, interface: 'loopback', address: null, process: 'ssh', pid: 430 },
      { port: 18080, interface: 'loopback', address: null, process: 'node', pid: 460 },
    ],
    tunnels: [
      {
        pid: 430,
        destination: 'ws-exemplo',
        since: new Date(at - (3 * 60 + 12) * MIN).toISOString(),
        ports: [
          { localPort: 14720, remoteHost: '127.0.0.1', remotePort: 4720, state: 'up', heldBy: null },
          { localPort: 13000, remoteHost: '127.0.0.1', remotePort: 3000, state: 'up', heldBy: null },
          { localPort: 15173, remoteHost: '127.0.0.1', remotePort: 5173, state: 'idle', heldBy: null },
          { localPort: 18080, remoteHost: '127.0.0.1', remotePort: 8080, state: 'busy', heldBy: 'node' },
        ],
      },
    ],
  };
}

function workstationReading(at: number): TelemetryReading {
  // 40 min period: above 16 when the wave passes 1/3, about 15 min in a row.
  const load = 14 + 6 * wave(at, 40) + 0.6 * noise('load', at);
  const cpu = Math.min(100, Math.max(5, (load / 16) * 70 + 10 * noise('cpu', at)));
  const sinceBoot = (at % (30 * 86_400_000)) / 1000;
  const cli = group(12, 18 + 6 * noise('cli', at), 3.1 * GB);
  return {
    takenAt: new Date(at).toISOString(),
    host: { hostname: 'ws-exemplo', platform: 'simulated', os: 'Ubuntu 24.04.1 LTS', arch: 'x64', uptimeSec: Math.round(12 * 86_400 + sinceBoot) },
    cpu: { cores: 16, model: 'CPU Exemplo de 16 vCPUs', usedPct: r1(cpu), load: { one: r2(load), five: r2(load * 0.93), fifteen: r2(load * 0.8) } },
    memory: { totalBytes: 62 * GiB, usedBytes: Math.round((29 + 2 * wave(at, 120)) * GB), swapTotalBytes: 124 * GiB, swapUsedBytes: Math.round(8.2 * GB), pressure: null },
    gpu: { name: 'GPU Exemplo T4', usedPct: Math.round(2 + 3 * noise('gpu', at)), memoryUsedBytes: Math.round(1.8 * GB), memoryTotalBytes: 15 * GiB },
    disk: {
      volumes: [
        { mount: '/', totalBytes: 170 * GB, usedBytes: 146 * GB, freeBytes: 24 * GB, usedPct: 85.9 },
        { mount: '/home', totalBytes: 492 * GB, usedBytes: 109 * GB, freeBytes: 383 * GB, usedPct: 22.2 },
        { mount: '/tmp', totalBytes: 206 * GB, usedBytes: 23 * GB, freeBytes: 183 * GB, usedPct: 11.2 },
      ],
    },
    network: { interface: 'ens5', rxBytesPerSec: Math.round(900e3 * (0.5 + noise('rx', at))), txBytesPerSec: Math.round(400e3 * (0.5 + noise('tx', at))), rxBytesTotal: Math.round(800 * GB + sinceBoot * 4e5), txBytesTotal: Math.round(120 * GB + sinceBoot * 1e5) },
    claude: { processes: cli, cli, desktop: group(0, 0, 0) },
    topProcesses: [
      { pid: 2001, name: 'java', cpuPct: 310, memoryBytes: 4.1e9 },
      { pid: 2050, name: 'postgres', cpuPct: 120, memoryBytes: 1.2e9 },
      { pid: 2100, name: 'claude', cpuPct: 12.5, memoryBytes: 510e6 },
      { pid: 2060, name: 'node', cpuPct: 9, memoryBytes: 380e6 },
      { pid: 2300, name: 'dockerd', cpuPct: 4, memoryBytes: 150e6 },
      { pid: 2200, name: 'node', cpuPct: 1, memoryBytes: 140e6 },
    ],
    docker: {
      running: 29,
      stopped: 77,
      stacks: [
        { name: 'catalogo-local', running: 8, stopped: 0, ports: [3000] },
        { name: 'loja-validacao', running: 0, stopped: 15, ports: [15432, 17233] },
        { name: 'motor-regras-int', running: 12, stopped: 0, ports: [18353] },
        { name: 'painel-metricas', running: 9, stopped: 0, ports: [14565] },
      ],
      space: [
        { type: 'Images', totalCount: 64, active: 21, sizeBytes: 33.9 * GB, reclaimableBytes: 8.7 * GB },
        { type: 'Containers', totalCount: 106, active: 29, sizeBytes: 2.5 * GB, reclaimableBytes: 0.7 * GB },
        { type: 'Local Volumes', totalCount: 31, active: 12, sizeBytes: 17.2 * GB, reclaimableBytes: 12.6 * GB },
        { type: 'Build Cache', totalCount: 412, active: 0, sizeBytes: 11.7 * GB, reclaimableBytes: 9.4 * GB },
      ],
    },
    ports: [
      { port: 22, interface: 'all', address: null, process: null, pid: null },
      { port: 3000, interface: 'loopback', address: null, process: 'vite', pid: 2350 },
      { port: 4720, interface: 'loopback', address: null, process: 'node', pid: 2200 },
      { port: 8080, interface: 'loopback', address: null, process: 'node', pid: 2060 },
      { port: 14565, interface: 'loopback', address: null, process: 'docker-proxy', pid: null },
      { port: 15432, interface: 'all', address: null, process: 'docker-proxy', pid: null },
      { port: 17233, interface: 'loopback', address: null, process: 'docker-proxy', pid: null },
      { port: 18353, interface: 'loopback', address: null, process: 'docker-proxy', pid: null },
    ],
    tunnels: null,
  };
}

/** The profile's synthetic reading at the given time. */
export function simulatedReading(profile: SimulatedProfile, atMs: number): TelemetryReading {
  return profile === 'local' ? localReading(atMs) : workstationReading(atMs);
}

/** The `--demo` collector: the synthetic reading for the clock's time. */
export class SimulatedCollector implements TelemetryCollector {
  private readonly profile: SimulatedProfile;
  private readonly now: () => number;

  constructor(profile: SimulatedProfile, now: () => number = Date.now) {
    this.profile = profile;
    this.now = now;
  }

  async collect(): Promise<TelemetryReading> {
    return simulatedReading(this.profile, this.now());
  }
}

/**
 * Seeds the machine's last `hours` hours of samples (one every 30 s, aligned to the clock), so the
 * 1 h and 12 h charts open already full. Returns how many it wrote.
 */
export async function seedTelemetry(store: TelemetryStore, machineId: string, profile: SimulatedProfile, now = Date.now(), hours = 12): Promise<number> {
  const end = Math.floor(now / SAMPLE_INTERVAL_MS) * SAMPLE_INTERVAL_MS;
  let n = 0;
  for (let at = end - hours * 3_600_000 + SAMPLE_INTERVAL_MS; at <= end; at += SAMPLE_INTERVAL_MS) {
    await store.putSample(machineId, simulatedReading(profile, at), RETENTION_MS);
    n++;
  }
  return n;
}
