// Os alertas da máquina, calculados sobre as amostras (#175, decisão 0008):
//
// - `load-high`: a carga de 1 min acima do número de núcleos em todas as amostras dos últimos 5 min;
// - `volume-full`: um volume acima de 85%;
// - `port-exposed`: uma porta em escuta em todas as interfaces;
// - `tunnel-busy`: uma porta do túnel que outro processo deste Mac segura.
//
// `computeAlerts` é puro: a leitura de agora e as amostras recentes dão os alertas que valem agora.
// `AlertTracker` guarda os abertos de cada máquina, mantém o `since` de quando cada um entrou e diz
// o que entrou e o que saiu; quem publica em `/api/mudancas` é o caso de uso (sampler.ts).

import {
  LOAD_HIGH_FOR_MS,
  samplePointOf,
  VOLUME_FULL_PCT,
  type Alert,
  type SamplePoint,
  type TelemetryReading,
} from './model.ts';

const numero = (n: number, casas = 1) => n.toLocaleString('pt-BR', { maximumFractionDigits: casas, minimumFractionDigits: 0 });

/** "146 GB", "1,8 TB", "512 MB": unidades de 1000, como o Finder e o `df -H`. */
export function formatBytes(bytes: number): string {
  const unidades = ['B', 'kB', 'MB', 'GB', 'TB', 'PB'];
  let v = bytes;
  let i = 0;
  while (v >= 1000 && i < unidades.length - 1) {
    v /= 1000;
    i++;
  }
  return `${numero(v, v >= 100 || i === 0 ? 0 : 1)} ${unidades[i]}`;
}

/**
 * Desde quando a carga está acima dos núcleos, sem interrupção, contando para trás a partir da
 * amostra mais nova. `null` quando a mais nova já não está acima.
 */
export function loadHighSince(points: readonly SamplePoint[]): number | null {
  const ordenadas = [...points].sort((a, b) => b.takenAt - a.takenAt);
  let desde: number | null = null;
  for (const p of ordenadas) {
    if (!(p.cores > 0 && p.load1 > p.cores)) break;
    desde = p.takenAt;
  }
  return desde;
}

/**
 * Os alertas que valem agora. `points` são as amostras recentes da máquina (as dos últimos minutos
 * bastam; a leitura de agora pode estar entre elas ou não).
 */
export function computeAlerts(reading: TelemetryReading, points: readonly SamplePoint[]): Alert[] {
  const agora = Date.parse(reading.takenAt);
  const agoraIso = reading.takenAt;
  const alerts: Alert[] = [];

  const comAgora = points.some((p) => p.takenAt === agora) ? points : [...points, samplePointOf(reading)];
  const desde = loadHighSince(comAgora);
  if (desde !== null && agora - desde >= LOAD_HIGH_FOR_MS) {
    const { cores, load } = reading.cpu;
    alerts.push({
      id: 'load-high',
      kind: 'load-high',
      level: 'error',
      message: `CPU saturada: carga de ${numero(load.one)} em ${cores} núcleos`,
      detail: `Carga de 5 min ${numero(load.five)}, de 15 min ${numero(load.fifteen)}`,
      since: new Date(desde).toISOString(),
    });
  }

  for (const v of reading.disk.volumes) {
    if (!(v.usedPct > VOLUME_FULL_PCT)) continue;
    alerts.push({
      id: `volume-full:${v.mount}`,
      kind: 'volume-full',
      level: 'warning',
      message: `O volume ${v.mount} passou de ${VOLUME_FULL_PCT}%`,
      detail: `${formatBytes(v.usedBytes)} de ${formatBytes(v.totalBytes)} usados (${Math.round(v.usedPct)}%) · ${formatBytes(v.freeBytes)} livres`,
      since: agoraIso,
    });
  }

  const expostas = new Map<number, string | null>();
  for (const p of reading.ports ?? []) {
    if (p.interface === 'all' && !expostas.has(p.port)) expostas.set(p.port, p.process);
  }
  for (const [port, processo] of [...expostas].sort((a, b) => a[0] - b[0])) {
    alerts.push({
      id: `port-exposed:${port}`,
      kind: 'port-exposed',
      level: 'warning',
      message: `A porta ${port} escuta em todas as interfaces`,
      detail: `${processo ?? 'processo desconhecido'} · qualquer um na rede alcança`,
      since: agoraIso,
    });
  }

  const ocupadas = new Set<number>();
  for (const t of reading.tunnels ?? []) {
    for (const p of t.ports) {
      if (p.state !== 'busy' || ocupadas.has(p.localPort)) continue;
      ocupadas.add(p.localPort);
      alerts.push({
        id: `tunnel-busy:${p.localPort}`,
        kind: 'tunnel-busy',
        level: 'warning',
        message: `A porta ${p.localPort} do túnel está ocupada`,
        detail: `${p.heldBy ?? 'Outro processo'} deste Mac segura a porta; o encaminhamento para ${t.destination} não chega lá`,
        since: agoraIso,
      });
    }
  }
  return alerts;
}

export interface AlertChange {
  machineId: string;
  alert: Alert;
  change: 'entered' | 'exited';
}

export interface AlertUpdate {
  entered: Alert[];
  exited: Alert[];
  active: Alert[];
}

/** Os alertas abertos de cada máquina, em memória: a passagem (entra, sai) é o que se publica. */
export class AlertTracker {
  private readonly abertos = new Map<string, Map<string, Alert>>();

  /** Troca os abertos da máquina pelos de agora; o `since` de quem já estava aberto fica o mais antigo. */
  update(machineId: string, agora: readonly Alert[]): AlertUpdate {
    const antes = this.abertos.get(machineId) ?? new Map<string, Alert>();
    const depois = new Map<string, Alert>();
    const entered: Alert[] = [];
    for (const a of agora) {
      const anterior = antes.get(a.id);
      if (anterior) {
        depois.set(a.id, { ...a, since: anterior.since < a.since ? anterior.since : a.since });
      } else {
        depois.set(a.id, a);
        entered.push(a);
      }
    }
    const exited = [...antes.values()].filter((a) => !depois.has(a.id));
    this.abertos.set(machineId, depois);
    return { entered, exited, active: [...depois.values()] };
  }

  active(machineId: string): Alert[] {
    return [...(this.abertos.get(machineId)?.values() ?? [])];
  }

  forget(machineId: string): void {
    this.abertos.delete(machineId);
  }
}
