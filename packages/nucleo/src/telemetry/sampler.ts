// O amostrador (#175): uma leitura a cada 30 s enquanto o núcleo está de pé, gravada com a poda de
// 12 h, e os alertas recalculados sobre as amostras recentes. O alerta que entra ou sai vira uma
// mudança `alert` no cursor de `/api/mudancas`, para a tela e a bandeja reagirem sem recarregar.
//
// - Sem sobreposição: se a leitura anterior ainda não acabou (um comando lento), a vez é pulada.
// - Leitura que falha (o coletor rejeitou, o banco recusou) só vai para o log: a próxima tenta de novo.
// - Timers injetáveis; nos testes, `sampleOnce()` direto, sem relógio.

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
  /** Cada alerta que entra ou sai. */
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

  /** Lê agora e, daí em diante, a cada `intervalMs`. Chamar de novo não liga outro timer. */
  start(): void {
    if (this.timer !== null) return;
    const timers = this.o.timers ?? systemTimers;
    this.timer = timers.setInterval(() => void this.tick(), this.o.intervalMs ?? SAMPLE_INTERVAL_MS);
    void this.tick();
  }

  /** Para o timer e espera a leitura em andamento. */
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

  /** Uma amostra: lê, grava (podando), recalcula os alertas e publica a passagem. */
  async sampleOnce(): Promise<TelemetryReading | null> {
    const { machineId, collector, store, tracker } = this.o;
    try {
      const reading = await collector.collect();
      await store.putSample(machineId, reading, this.o.retentionMs ?? RETENTION_MS);
      const at = Date.parse(reading.takenAt);
      // Um pouco mais que os 5 min do alerta de carga, para a primeira amostra da janela entrar.
      const points = await store.listPoints(machineId, at - LOAD_HIGH_FOR_MS - 2 * (this.o.intervalMs ?? SAMPLE_INTERVAL_MS));
      const update = tracker.update(machineId, computeAlerts(reading, points));
      for (const alert of update.entered) this.o.onAlertChange?.({ machineId, alert, change: 'entered' });
      for (const alert of update.exited) this.o.onAlertChange?.({ machineId, alert, change: 'exited' });
      return reading;
    } catch (err) {
      this.o.log?.(`telemetria (${machineId}): ${(err as Error).message}`);
      return null;
    }
  }
}

/** Publica a passagem de cada alerta no cursor de mudanças, como `alert` com a chave `<máquina>:<alerta>`. */
export function publishAlertChanges(cursor: CursorDeMudancas): (change: AlertChange) => void {
  return ({ machineId, alert }) => {
    cursor.registrar({ tipo: 'alert', chave: `${machineId}:${alert.id}`, sessionId: null, accountId: null });
  };
}
