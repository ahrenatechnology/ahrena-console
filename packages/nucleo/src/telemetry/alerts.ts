// The machine's alerts, computed over the samples (#175, decision 0008):
//
// - `load-high`: the 1 min load above the core count in every sample of the last 5 min;
// - `volume-full`: a volume above 85%;
// - `port-exposed`: a port listening on all interfaces;
// - `tunnel-busy`: a tunnel port that another process on this Mac holds;
// - `terminal-stuck` (#350): a terminal whose foreground command is "presa" (src/telemetry/terminals.ts);
// - `memory-high` (#564): the macOS memory pressure `warning`/`critical`, or, with no pressure reported, memory used at 90% / 95%;
// - `swap-high` (#564): swap used at 80% (warning) / 90% (error) of a known, non-zero total;
// - `machine-unreachable` (#176): a remote machine this Mac cannot read (`machineUnreachableAlert`).
//
// `computeAlerts` is pure: the current reading and the recent samples give the alerts that hold now.
// `AlertTracker` keeps each machine's open alerts, keeps the `since` of when each one entered and
// says what entered and what exited; publishing to `/api/changes` is the use case's job (sampler.ts).

import {
  LOAD_HIGH_FOR_MS,
  MEMORY_HIGH_ERROR_PCT,
  MEMORY_HIGH_WARNING_PCT,
  samplePointOf,
  SWAP_HIGH_ERROR_PCT,
  SWAP_HIGH_WARNING_PCT,
  VOLUME_FULL_PCT,
  type Alert,
  type SamplePoint,
  type TelemetryReading,
  type UnreachableReason,
} from './model.ts';

const formatNumber = (n: number, digits = 1) => n.toLocaleString('pt-BR', { maximumFractionDigits: digits, minimumFractionDigits: 0 });

/** "146 GB", "1,8 TB", "512 MB": units of 1000, like Finder and `df -H`. */
export function formatBytes(bytes: number): string {
  const units = ['B', 'kB', 'MB', 'GB', 'TB', 'PB'];
  let v = bytes;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${formatNumber(v, v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * Since when the load has been above the core count without a break, counting back from the newest
 * sample. `null` when the newest one is no longer above.
 */
export function loadHighSince(points: readonly SamplePoint[]): number | null {
  const sorted = [...points].sort((a, b) => b.takenAt - a.takenAt);
  let since: number | null = null;
  for (const p of sorted) {
    if (!(p.cores > 0 && p.load1 > p.cores)) break;
    since = p.takenAt;
  }
  return since;
}

/**
 * The alerts that hold now. `points` are the machine's recent samples (the last few minutes are
 * enough; the current reading may or may not be among them).
 */
export function computeAlerts(reading: TelemetryReading, points: readonly SamplePoint[]): Alert[] {
  const now = Date.parse(reading.takenAt);
  const nowIso = reading.takenAt;
  const alerts: Alert[] = [];

  const withNow = points.some((p) => p.takenAt === now) ? points : [...points, samplePointOf(reading)];
  const since = loadHighSince(withNow);
  if (since !== null && now - since >= LOAD_HIGH_FOR_MS) {
    const { cores, load } = reading.cpu;
    alerts.push({
      id: 'load-high',
      kind: 'load-high',
      level: 'error',
      message: `CPU saturada: carga de ${formatNumber(load.one)} em ${cores} núcleos`,
      detail: `Carga de 5 min ${formatNumber(load.five)}, de 15 min ${formatNumber(load.fifteen)}`,
      since: new Date(since).toISOString(),
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
      since: nowIso,
    });
  }

  const memoryAlert = memoryHighAlert(reading, nowIso);
  if (memoryAlert) alerts.push(memoryAlert);
  const swapAlert = swapHighAlert(reading, nowIso);
  if (swapAlert) alerts.push(swapAlert);

  const exposedPorts = new Map<number, string | null>();
  for (const p of reading.ports ?? []) {
    if (p.interface === 'all' && !exposedPorts.has(p.port)) exposedPorts.set(p.port, p.process);
  }
  for (const [port, processName] of [...exposedPorts].sort((a, b) => a[0] - b[0])) {
    alerts.push({
      id: `port-exposed:${port}`,
      kind: 'port-exposed',
      level: 'warning',
      message: `A porta ${port} escuta em todas as interfaces`,
      detail: `${processName ?? 'processo desconhecido'} · qualquer um na rede alcança`,
      since: nowIso,
    });
  }

  const busyPorts = new Set<number>();
  for (const t of reading.tunnels ?? []) {
    for (const p of t.ports) {
      if (p.state !== 'busy' || busyPorts.has(p.localPort)) continue;
      busyPorts.add(p.localPort);
      alerts.push({
        id: `tunnel-busy:${p.localPort}`,
        kind: 'tunnel-busy',
        level: 'warning',
        message: `A porta ${p.localPort} do túnel está ocupada`,
        detail: `${p.heldBy ?? 'Outro processo'} deste Mac segura a porta; o encaminhamento para ${t.destination} não chega lá`,
        since: nowIso,
      });
    }
  }

  for (const s of reading.terminals?.sessions ?? []) {
    if (!s.stuck || !s.foreground) continue;
    const command = shortCommand(s.foreground.args);
    alerts.push({
      id: `terminal-stuck:${s.id}`,
      kind: 'terminal-stuck',
      level: 'error',
      message: `O terminal ${s.tty} está preso há ${formatAge(s.foreground.ageSec)}`,
      detail: `${command}${s.claudeSessionId ? ` · da sessão do Claude ${s.claudeSessionId.slice(0, 8)}` : ''}`,
      since: new Date(now - s.foreground.ageSec * 1000).toISOString(),
    });
  }
  return alerts;
}

/** Memory under pressure: the macOS level when there is one (`normal` means none), else the used share of the total. */
function memoryHighAlert(reading: TelemetryReading, since: string): Alert | null {
  const { totalBytes, usedBytes, pressure } = reading.memory;
  const usedPct = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;
  let level: Alert['level'] | null;
  if (pressure !== null) level = pressure === 'critical' ? 'error' : pressure === 'warning' ? 'warning' : null;
  else level = usedPct >= MEMORY_HIGH_ERROR_PCT ? 'error' : usedPct >= MEMORY_HIGH_WARNING_PCT ? 'warning' : null;
  if (level === null) return null;
  const used = `${formatBytes(usedBytes)} de ${formatBytes(totalBytes)} usados (${Math.round(usedPct)}%)`;
  return {
    id: 'memory-high',
    kind: 'memory-high',
    level,
    message: level === 'error' ? 'Memória sob pressão crítica' : 'Memória sob pressão',
    detail: pressure !== null ? `${used} · pressão ${pressure === 'critical' ? 'crítica' : 'de aviso'} no macOS` : used,
    since,
  };
}

/** Swap nearly full: only when the total is known and above zero. */
function swapHighAlert(reading: TelemetryReading, since: string): Alert | null {
  const { swapTotalBytes, swapUsedBytes } = reading.memory;
  if (swapTotalBytes === null || swapUsedBytes === null || !(swapTotalBytes > 0)) return null;
  const usedPct = (swapUsedBytes / swapTotalBytes) * 100;
  const level: Alert['level'] | null = usedPct >= SWAP_HIGH_ERROR_PCT ? 'error' : usedPct >= SWAP_HIGH_WARNING_PCT ? 'warning' : null;
  if (level === null) return null;
  return {
    id: 'swap-high',
    kind: 'swap-high',
    level,
    message: `O swap está ${Math.round(usedPct)}% ocupado`,
    detail: `${formatBytes(swapUsedBytes)} de ${formatBytes(swapTotalBytes)} usados (${Math.round(usedPct)}%)`,
    since,
  };
}

/** `bash /tmp/claude-…/scratchpad/destrava-pedro.sh` → `bash …/destrava-pedro.sh`: long paths keep only their last name. */
export function shortCommand(args: string): string {
  const out = args.split(/\s+/).map((t) => (t.length > 40 && t.includes('/') ? `…/${t.slice(t.lastIndexOf('/') + 1)}` : t)).join(' ');
  return out.length > 80 ? `${out.slice(0, 79)}…` : out;
}

/** "26 min", "1 h 05", "45 s". */
export function formatAge(sec: number): string {
  if (sec < 60) return `${sec} s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`;
}

/**
 * A remote machine that does not answer, as the screen says it. The three owner-proof reasons
 * (`owner-auth-required`, `owner-auth-failed`, `owner-auth-mismatch`, #388) read "Workstation sem
 * acesso": the tunnel is up and the core over there refuses this Mac. The others read "Workstation
 * sem conexão", and the detail tells the two cases of decision 0008 section 3 apart: the tunnel
 * down, or the tunnel up and the núcleo over there not answering.
 */
export function machineUnreachableAlert(label: string, port: number, reason: UnreachableReason, since: string): Alert {
  return {
    id: 'machine-unreachable',
    kind: 'machine-unreachable',
    // Yellow when there is something to configure (the proof is missing), red when it failed (wireframe 388-4).
    level: reason === 'owner-auth-required' ? 'warning' : 'error',
    // The owner proof (#388): the tunnel is up and the port answers, so the core over there refuses: "sem acesso".
    message: reason.startsWith('owner-auth-') ? `${label} sem acesso` : `${label} sem conexão`,
    detail:
      reason === 'owner-auth-required'
        ? 'O núcleo remoto exige autenticação do dono; a conexão remota ainda não fornece essa prova.'
        : reason === 'owner-auth-failed'
        ? 'O núcleo remoto exige autenticação do dono, e o comando de credencial não trouxe uma prova aceita.'
        : reason === 'owner-auth-mismatch'
        ? 'A credencial veio de outra máquina ou de outro usuário que os da primeira conexão; nada foi enviado.'
        : reason === 'port-closed'
        ? `A porta ${port} deste Mac não aceita conexão: o túnel está caído`
        : `O túnel está de pé na porta ${port}, mas o núcleo de lá não respondeu`,
    since,
  };
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

/** Each machine's open alerts, in memory: the transition (enter, exit) is what gets published. */
export class AlertTracker {
  private readonly open = new Map<string, Map<string, Alert>>();

  /** Replaces the machine's open alerts with the current ones; an alert already open keeps the oldest `since`. */
  update(machineId: string, now: readonly Alert[]): AlertUpdate {
    const before = this.open.get(machineId) ?? new Map<string, Alert>();
    const after = new Map<string, Alert>();
    const entered: Alert[] = [];
    for (const a of now) {
      const previous = before.get(a.id);
      if (previous) {
        after.set(a.id, { ...a, since: previous.since < a.since ? previous.since : a.since });
      } else {
        after.set(a.id, a);
        entered.push(a);
      }
    }
    const exited = [...before.values()].filter((a) => !after.has(a.id));
    this.open.set(machineId, after);
    return { entered, exited, active: [...after.values()] };
  }

  active(machineId: string): Alert[] {
    return [...(this.open.get(machineId)?.values() ?? [])];
  }

  forget(machineId: string): void {
    this.open.delete(machineId);
  }
}
