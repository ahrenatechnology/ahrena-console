// The remote machines of machines.json, kept in step with the file (#244, decision 0012 section 2).
// Until #244 src/api/cli.ts built one RemoteMachine per entry once, at start; now this registry
// refreshes the file every 30 s (and the reconnect route refreshes it right before running), and:
//
// - a machine added to the file is created and, once the registry runs, started;
// - a machine removed is stopped, and `onRemoved` lets the caller close its alerts;
// - a machine whose label or port changed is replaced (stopped, created again, started);
// - a machine whose `reconnect` alone changed is kept: the reconnect is read from here
//   (`reconnectOf`), never from a stale copy;
// - a machine on the core's own port is skipped, with a log line, as before;
// - an invalid file keeps the machines of the last good reading (MachinesFileSource).
//
// Each machine added, removed or changed calls `onChange(id)` (published on /api/changes), so the
// screen and the tray pick up an edit without waiting for their own re-read. Refreshes never
// overlap; timers are injectable.

import type { MachinesFileSource, ReconnectConfig, RemoteMachineConfig } from './machines-config.ts';
import { SAMPLE_INTERVAL_MS } from './model.ts';
import { systemTimers, type SamplerTimers } from './sampler.ts';

/** What the registry needs of a remote machine (RemoteMachine in production, a double in tests). */
export interface ManagedMachine {
  readonly id: string;
  readonly label: string;
  readonly port: number;
  start(): void;
  stop(): Promise<void>;
}

export interface RemoteMachinesOptions<M extends ManagedMachine> {
  source: Pick<MachinesFileSource, 'refresh'>;
  create: (config: RemoteMachineConfig) => M;
  /** The core's own port: a machine on it would be this core reading itself. */
  ownPort: number;
  onChange?: (machineId: string) => void;
  onRemoved?: (machineId: string) => void;
  intervalMs?: number;
  timers?: SamplerTimers;
  log?: (message: string) => void;
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export class RemoteMachines<M extends ManagedMachine> {
  private readonly o: RemoteMachinesOptions<M>;
  private machines = new Map<string, { machine: M; config: RemoteMachineConfig }>();
  private skipped = new Set<string>();
  private timer: unknown = null;
  private running = false;
  private inFlight: Promise<void> | null = null;

  constructor(options: RemoteMachinesOptions<M>) {
    this.o = options;
  }

  /** In the file's order. */
  list(): M[] {
    return [...this.machines.values()].map((e) => e.machine);
  }

  get(id: string): M | undefined {
    return this.machines.get(id)?.machine;
  }

  has(id: string): boolean {
    return this.machines.has(id);
  }

  /** The machine's reconnect in the last good reading: `undefined` for an unknown id, `null` without one. */
  reconnectOf(id: string): ReconnectConfig | null | undefined {
    const e = this.machines.get(id);
    return e ? (e.config.reconnect ?? null) : undefined;
  }

  /** Reads the file if it changed and applies it. A refresh already running is joined, then one more runs. */
  async refresh(): Promise<void> {
    while (this.inFlight) await this.inFlight;
    this.inFlight = this.apply().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** Starts every machine and the 30 s refresh. Calling it again does nothing. */
  start(): void {
    if (this.running) return;
    this.running = true;
    for (const { machine } of this.machines.values()) machine.start();
    this.timer = (this.o.timers ?? systemTimers).setInterval(() => {
      if (!this.inFlight) void this.refresh().catch((err) => this.o.log?.(`machines: ${(err as Error).message}`));
    }, this.o.intervalMs ?? SAMPLE_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer !== null) (this.o.timers ?? systemTimers).clearInterval(this.timer);
    this.timer = null;
    await this.inFlight?.catch(() => undefined);
    await Promise.all(this.list().map((m) => m.stop()));
  }

  private async apply(): Promise<void> {
    const { config, changed } = await this.o.source.refresh();
    if (!changed) return;
    const next = new Map<string, RemoteMachineConfig>();
    const skipped = new Set<string>();
    for (const c of config.machines) {
      if (c.port === this.o.ownPort) {
        if (!this.skipped.has(c.id)) this.o.log?.(`machines: ${c.id} uses port ${c.port}, this core's own; skipped`);
        skipped.add(c.id);
        continue;
      }
      next.set(c.id, c);
    }
    this.skipped = skipped;

    const result = new Map<string, { machine: M; config: RemoteMachineConfig }>();
    const stops: Promise<void>[] = [];
    const touched: string[] = [];
    for (const [id, old] of this.machines) {
      if (next.has(id)) continue;
      stops.push(old.machine.stop());
      this.o.onRemoved?.(id);
      touched.push(id);
    }
    for (const [id, c] of next) {
      const old = this.machines.get(id);
      if (old && old.config.label === c.label && old.config.port === c.port) {
        result.set(id, { machine: old.machine, config: c });
        if (!sameJson(old.config.reconnect, c.reconnect)) touched.push(id);
        continue;
      }
      if (old) stops.push(old.machine.stop());
      const machine = this.o.create(c);
      result.set(id, { machine, config: c });
      if (this.running) machine.start();
      touched.push(id);
    }
    this.machines = result;
    await Promise.all(stops);
    if (touched.length > 0) this.o.log?.(`machines: ${this.machines.size} remote machine(s)${this.machines.size ? `: ${this.list().map((m) => `${m.id} on port ${m.port}`).join(', ')}` : ''}`);
    for (const id of touched) this.o.onChange?.(id);
  }
}
