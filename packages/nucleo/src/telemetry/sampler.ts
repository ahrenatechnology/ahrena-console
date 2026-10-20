// The sampler (#175): one reading every 30 s while the núcleo is up, written with the 12 h pruning,
// and the alerts recomputed over the recent samples. An alert that enters or exits becomes an
// `alert` change on the `/api/changes` cursor, so the screen and the tray react without reloading.
//
// - No overlap: if the previous reading has not finished (a slow command), the turn is skipped.
// - A failed reading (the collector rejected, the database refused) only goes to the log: the next
//   one tries again.
// - Injectable timers; in tests, `sampleOnce()` directly, without a clock.

import type { CursorDeMudancas } from '../mudancas/cursor.ts';
import { AlertTracker, computeAlerts, type AlertChange } from './alerts.ts';
import { LOAD_HIGH_FOR_MS, RETENTION_MS, SAMPLE_INTERVAL_MS, type TelemetryReading } from './model.ts';
import type { TelemetryCollector, TelemetryStore } from './ports.ts';

export interface SamplerTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const systemTimers: SamplerTimers = {
  setInterval: (fn, ms) => {
    const t = setInterval(fn, ms);
    t.unref?.();
    return t;
  },
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export interface TelemetrySamplerOptions {
  machineId: string;
  collector: TelemetryCollector;
  store: TelemetryStore;
  tracker: AlertTracker;
  /** Every alert that enters or exits. */
  onAlertChange?: (change: AlertChange) => void;
  intervalMs?: number;
  retentionMs?: number;
  timers?: SamplerTimers;
  log?: (message: string) => void;
}

export class TelemetrySampler {
  readonly machineId: string;
  private readonly o: TelemetrySamplerOptions;
  private timer: unknown = null;
  private inFlight: Promise<TelemetryReading | null> | null = null;

  constructor(options: TelemetrySamplerOptions) {
    this.o = options;
    this.machineId = options.machineId;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  /** Reads now and then every `intervalMs`. Calling it again does not start another timer. */
  start(): void {
    if (this.timer !== null) return;
    const timers = this.o.timers ?? systemTimers;
    this.timer = timers.setInterval(() => void this.tick(), this.o.intervalMs ?? SAMPLE_INTERVAL_MS);
    void this.tick();
  }

  /** Stops the timer and waits for the reading in progress. */
  async stop(): Promise<void> {
    if (this.timer !== null) (this.o.timers ?? systemTimers).clearInterval(this.timer);
    this.timer = null;
    await this.inFlight?.catch(() => null);
  }

  private tick(): Promise<TelemetryReading | null> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.sampleOnce().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** One sample: read, write (pruning), recompute the alerts and publish the transitions. */
  async sampleOnce(): Promise<TelemetryReading | null> {
    const { machineId, collector, store, tracker } = this.o;
    try {
      const reading = await collector.collect();
      await store.putSample(machineId, reading, this.o.retentionMs ?? RETENTION_MS);
      const at = Date.parse(reading.takenAt);
      // A little more than the load alert's 5 min, so the window's first sample is included.
      const points = await store.listPoints(machineId, at - LOAD_HIGH_FOR_MS - 2 * (this.o.intervalMs ?? SAMPLE_INTERVAL_MS));
      const update = tracker.update(machineId, computeAlerts(reading, points));
      for (const alert of update.entered) this.o.onAlertChange?.({ machineId, alert, change: 'entered' });
      for (const alert of update.exited) this.o.onAlertChange?.({ machineId, alert, change: 'exited' });
      return reading;
    } catch (err) {
      this.o.log?.(`telemetry (${machineId}): ${(err as Error).message}`);
      return null;
    }
  }
}

/** Publishes each alert transition on the change cursor, as `alert` with the key `<machine>:<alert>`. */
export function publishAlertChanges(cursor: CursorDeMudancas): (change: AlertChange) => void {
  return ({ machineId, alert }) => {
    cursor.registrar({ tipo: 'alert', chave: `${machineId}:${alert.id}`, sessionId: null, accountId: null });
  };
}
