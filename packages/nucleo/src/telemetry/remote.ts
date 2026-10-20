// A remote machine (#176, decision 0008 sections 2 and 3): another núcleo, reached through the local
// port the user's tunnel forwards. Every 30 s (and once on start) this Mac's núcleo asks it for
// `GET /api/telemetry` and, when that answers, `GET /api/attention`, through `RemoteGet`.
//
// - The state: `connected`; `unreachable` with the reason (`port-closed`, `no-response`);
//   `incompatible-version` when the `version` of its telemetry is not this one's (or it has no
//   telemetry route at all). Until the first read ends, `unreachable` with no reason.
// - The newest reading goes into the same `TelemetryStore`, under the remote's id, projected and
//   capped (storableReading) and stamped with the time this Mac read it: the screen opens with it,
//   and with its age, while the machine is down.
// - The alerts: the ones the remote computed over its own samples, plus `machine-unreachable`
//   ("Workstation sem conexão") while it cannot be read. Each one that enters or exits is published,
//   like this machine's (sampler.ts), so a machine that goes down or comes back reaches `/api/changes`.
// - Its sessions that need you: the remote's attention answer, kept while connected and handed to
//   the attention route (api/attention-route.ts), which marks them with this machine. A session that
//   enters or leaves it is published too, so the tray refreshes.
// - `GET` only, never overlapping, injectable timers and clock; in tests, `pollOnce()` directly.

import type { ChangeCursor } from '../changes/cursor.ts';
import { machineUnreachableAlert, type AlertChange, type AlertTracker } from './alerts.ts';
import type { RemoteMachineConfig } from './machines-config.ts';
import { RETENTION_MS, SAMPLE_INTERVAL_MS, TELEMETRY_VERSION, type Alert, type AlertKind, type MachineState, type TelemetryReading } from './model.ts';
import type { RemoteGet, TelemetryStore } from './ports.ts';
import { systemTimers, type SamplerTimers } from './sampler.ts';
import type { MachineEntry, MachineStatus } from './service.ts';

export const REMOTE_TELEMETRY_PATH = '/api/telemetry';
/** The remote núcleo's attention route (src/api/attention-route.ts `ATTENTION_ROUTE`). */
export const REMOTE_ATTENTION_PATH = '/api/attention';

export interface RemoteSessionChange {
  machineId: string;
  sessionId: string;
}

export interface RemoteMachineOptions {
  config: RemoteMachineConfig;
  get: RemoteGet;
  store: TelemetryStore;
  tracker: AlertTracker;
  onAlertChange?: (change: AlertChange) => void;
  /** A remote session that entered or left the remote's attention list. */
  onAttentionChange?: (change: RemoteSessionChange) => void;
  now?: () => number;
  intervalMs?: number;
  retentionMs?: number;
  timers?: SamplerTimers;
  log?: (message: string) => void;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isNumberOrNull = (v: unknown) => v === null || isNumber(v);
const text = (v: unknown, max: number): string | null => (typeof v === 'string' ? v.slice(0, max) : null);

/** A stored remote reading never exceeds this, serialized (a real one is a few kB). */
export const MAX_REMOTE_READING_BYTES = 256 * 1024;
export const MAX_REMOTE_VOLUMES = 64;
export const MAX_REMOTE_ALERTS = 50;
/** The remote's alert kinds this núcleo knows; `machine-unreachable` is this Mac's to compute. */
const REMOTE_ALERT_KINDS: readonly AlertKind[] = ['load-high', 'volume-full', 'port-exposed', 'tunnel-busy'];

/**
 * The remote's reading, projected onto `TelemetryReading`, with `takenAt` set to when THIS Mac read
 * it: the remote's clock never decides what gets pruned or what is "latest", and `lastReadAt` is the
 * age of the read. `null` when it lacks what a sample needs (the columns of `telemetry_samples`) or
 * is too large. Groups beyond the series (`claude`, `topProcesses`, `docker`, `ports`, `tunnels`) are
 * kept as sent, inside the size cap.
 */
export function storableReading(v: unknown, readAt: number): TelemetryReading | null {
  if (!isObject(v)) return null;
  const { host, cpu, memory, disk, network, gpu } = v;
  if (!isObject(host) || !isObject(cpu) || !Number.isInteger(cpu.cores) || !isNumberOrNull(cpu.usedPct) || !isObject(cpu.load)) return null;
  const { one, five, fifteen } = cpu.load;
  if (!isNumber(one) || !isNumber(five) || !isNumber(fifteen)) return null;
  if (!isObject(memory) || !isNumber(memory.totalBytes) || !isNumber(memory.usedBytes) || !isNumberOrNull(memory.swapUsedBytes) || !isNumberOrNull(memory.swapTotalBytes)) return null;
  if (!isObject(disk) || !Array.isArray(disk.volumes)) return null;
  if (network !== null && !(isObject(network) && isNumberOrNull(network.rxBytesPerSec) && isNumberOrNull(network.txBytesPerSec))) return null;
  if (gpu !== null && !(isObject(gpu) && isNumberOrNull(gpu.usedPct))) return null;
  const volumes = disk.volumes.slice(0, MAX_REMOTE_VOLUMES).flatMap((x) =>
    isObject(x) && typeof x.mount === 'string' && isNumber(x.totalBytes) && isNumber(x.usedBytes) && isNumber(x.freeBytes) && isNumber(x.usedPct)
      ? [{ mount: x.mount.slice(0, 256), totalBytes: x.totalBytes, usedBytes: x.usedBytes, freeBytes: x.freeBytes, usedPct: x.usedPct }]
      : [],
  );
  const platform = host.platform === 'darwin' || host.platform === 'linux' || host.platform === 'simulated' ? host.platform : 'linux';
  const reading = {
    takenAt: new Date(readAt).toISOString(),
    host: { hostname: text(host.hostname, 128) ?? '', platform, os: text(host.os, 128), arch: text(host.arch, 32) ?? '', uptimeSec: isNumber(host.uptimeSec) ? host.uptimeSec : 0 },
    cpu: { cores: cpu.cores as number, model: text(cpu.model, 128), usedPct: cpu.usedPct as number | null, load: { one, five, fifteen } },
    memory: {
      totalBytes: memory.totalBytes,
      usedBytes: memory.usedBytes,
      swapTotalBytes: memory.swapTotalBytes as number | null,
      swapUsedBytes: memory.swapUsedBytes as number | null,
      pressure: memory.pressure === 'normal' || memory.pressure === 'warning' || memory.pressure === 'critical' ? memory.pressure : null,
    },
    gpu: gpu as TelemetryReading['gpu'],
    disk: { volumes },
    network: network as TelemetryReading['network'],
    claude: (v.claude ?? null) as TelemetryReading['claude'],
    topProcesses: Array.isArray(v.topProcesses) ? (v.topProcesses as TelemetryReading['topProcesses']) : null,
    docker: (v.docker ?? null) as TelemetryReading['docker'],
    ports: Array.isArray(v.ports) ? (v.ports as TelemetryReading['ports']) : null,
    tunnels: Array.isArray(v.tunnels) ? (v.tunnels as TelemetryReading['tunnels']) : null,
  } satisfies TelemetryReading;
  return Buffer.byteLength(JSON.stringify(reading)) <= MAX_REMOTE_READING_BYTES ? reading : null;
}

/** The remote's own alerts that have the alert shape, with known kinds and capped texts; at most 50. */
export function remoteAlerts(v: unknown): Alert[] {
  if (!Array.isArray(v)) return [];
  const out: Alert[] = [];
  for (const a of v) {
    if (out.length >= MAX_REMOTE_ALERTS) break;
    if (!isObject(a) || typeof a.kind !== 'string' || !REMOTE_ALERT_KINDS.includes(a.kind as AlertKind)) continue;
    const id = text(a.id, 128);
    const message = text(a.message, 200);
    const since = text(a.since, 40);
    // The id is namespaced by its kind (`load-high`, `volume-full:/`), so a remote can never open an
    // alert under an id this Mac computes (`machine-unreachable`).
    if (!id || (id !== a.kind && !id.startsWith(`${a.kind}:`)) || !message || !since || (a.level !== 'error' && a.level !== 'warning') || (a.detail !== null && typeof a.detail !== 'string')) continue;
    out.push({ id, kind: a.kind as AlertKind, level: a.level, message, detail: text(a.detail, 300), since });
  }
  return out;
}

// A remote núcleo released before #173 phase 2b answers `/api/attention` with the Portuguese body
// (the one the old `/api/atencao` keeps until phase 6): `itens[{ sessao, titulo, projeto, conta {
// rotulo, cor }, nivel, motivo, motivoLongo, desde, minutos, local, machine }]`, `ativas`, `comErro`.
// `englishAttentionBody` reads it as the English one, so the attention route and the changes read one
// shape; a body that already has `items` passes untouched.
const OLD_ATTENTION_LEVELS: Readonly<Record<string, string>> = { precisa: 'needs', 'sua-vez': 'your-turn' };
const OLD_ATTENTION_REASONS: Readonly<Record<string, string>> = {
  permissao: 'permission',
  pergunta: 'question',
  plano: 'plan',
  decisao: 'decision',
  erro: 'error',
  'sua-vez': 'your-turn',
  interrompida: 'interrupted',
};
const englishValue = (map: Readonly<Record<string, string>>, v: unknown) => (typeof v === 'string' && Object.hasOwn(map, v) ? map[v] : v);

/** A remote attention answer with the English keys and values (src/api/attention-route.ts `RespostaDaAtencao`). */
export function englishAttentionBody(body: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(body.items) || !Array.isArray(body.itens)) return body;
  const items = body.itens.slice(0, 200).map((i) =>
    isObject(i)
      ? {
          session: i.sessao,
          title: i.titulo,
          project: i.projeto,
          account: isObject(i.conta) ? { label: i.conta.rotulo, color: i.conta.cor } : i.conta,
          level: englishValue(OLD_ATTENTION_LEVELS, i.nivel),
          reason: englishValue(OLD_ATTENTION_REASONS, i.motivo),
          longReason: i.motivoLongo,
          since: i.desde,
          minutes: i.minutos,
          local: i.local,
          machine: i.machine,
        }
      : i,
  );
  return { active: body.ativas, withError: body.comErro, items };
}

/** The sessions in a remote attention answer and the reason of each (for what entered, left or changed). */
function attentionSessions(body: unknown): Map<string, string> {
  const items = isObject(body) && Array.isArray(body.items) ? body.items.slice(0, 200) : [];
  const out = new Map<string, string>();
  for (const i of items) {
    // The same basic checks as the attention route's `remoteAttentionItems`, and the same 128-char
    // session id, so a published change always matches an item the route serves.
    if (!isObject(i) || typeof i.session !== 'string' || !i.session || typeof i.reason !== 'string' || typeof i.level !== 'string' || !isNumber(i.minutes)) continue;
    if (i.machine !== null && i.machine !== undefined) continue;
    out.set(i.session.slice(0, 128), i.reason);
  }
  return out;
}

const INITIAL: MachineStatus = { state: 'unreachable', reason: null, version: null };

export class RemoteMachine implements MachineEntry {
  readonly id: string;
  readonly label: string;
  readonly port: number;
  private readonly o: RemoteMachineOptions;
  private current: MachineStatus = INITIAL;
  private lastAttention: unknown = null;
  private timer: unknown = null;
  private inFlight: Promise<MachineStatus> | null = null;

  constructor(options: RemoteMachineOptions) {
    this.o = options;
    this.id = options.config.id;
    this.label = options.config.label;
    this.port = options.config.port;
  }

  state(): MachineState {
    return this.current.state;
  }

  status(): MachineStatus {
    return this.current;
  }

  /** The remote's last attention answer while connected; `null` otherwise. */
  attention(): unknown {
    return this.lastAttention;
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

  async stop(): Promise<void> {
    if (this.timer !== null) (this.o.timers ?? systemTimers).clearInterval(this.timer);
    this.timer = null;
    await this.inFlight?.catch(() => null);
  }

  private tick(): Promise<MachineStatus> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.pollOnce().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** One read of the remote núcleo: state, newest reading, alerts and sessions that need you. */
  async pollOnce(): Promise<MachineStatus> {
    const { get, store, tracker } = this.o;
    const now = (this.o.now ?? Date.now)();
    const t = await get(this.port, REMOTE_TELEMETRY_PATH);

    let next: MachineStatus;
    let alerts: Alert[] = [];
    let attention: unknown = null;
    if (t.kind === 'unreachable') {
      next = { state: 'unreachable', reason: t.reason, version: null };
    } else if (t.status === 200 && isObject(t.body) && isNumber(t.body.version)) {
      const version = t.body.version;
      next = version === TELEMETRY_VERSION ? { state: 'connected', reason: null, version } : { state: 'incompatible-version', reason: null, version };
    } else if (t.status === 200 || t.status === 404) {
      // A núcleo that answers but has no telemetry this one understands (an older one gives 404).
      next = { state: 'incompatible-version', reason: null, version: null };
    } else {
      next = { state: 'unreachable', reason: 'no-response', version: null };
    }

    if (next.state === 'connected' && t.kind === 'response' && isObject(t.body)) {
      const reading = storableReading(t.body.current, now);
      if (reading) {
        try {
          await store.putSample(this.id, reading, this.o.retentionMs ?? RETENTION_MS);
        } catch (err) {
          this.o.log?.(`telemetry (${this.id}): ${(err as Error).message}`);
        }
      }
      alerts = remoteAlerts(t.body.alerts);
      const a = await get(this.port, REMOTE_ATTENTION_PATH);
      attention = a.kind === 'response' && a.status === 200 && isObject(a.body) ? englishAttentionBody(a.body) : null;
    }
    if (next.state === 'unreachable' && next.reason) alerts.push(machineUnreachableAlert(this.label, this.port, next.reason, new Date(now).toISOString()));

    const reasonChanged = this.current.reason !== null && next.reason !== null && this.current.reason !== next.reason;
    this.logTransition(next);
    this.current = next;
    this.publishAttention(attention);
    const update = tracker.update(this.id, alerts);
    for (const alert of update.entered) this.o.onAlertChange?.({ machineId: this.id, alert, change: 'entered' });
    // From "the tunnel is down" to "the núcleo over there is down" (or back): same alert, new detail.
    if (reasonChanged) {
      const alert = update.active.find((a) => a.id === 'machine-unreachable');
      if (alert && !update.entered.includes(alert)) this.o.onAlertChange?.({ machineId: this.id, alert, change: 'entered' });
    }
    for (const alert of update.exited) this.o.onAlertChange?.({ machineId: this.id, alert, change: 'exited' });
    return next;
  }

  private publishAttention(next: unknown): void {
    const before = attentionSessions(this.lastAttention);
    const after = attentionSessions(next);
    this.lastAttention = next;
    for (const sessionId of new Set([...before.keys(), ...after.keys()])) {
      if (before.get(sessionId) !== after.get(sessionId)) this.o.onAttentionChange?.({ machineId: this.id, sessionId });
    }
  }

  private logTransition(next: MachineStatus): void {
    const was = this.current;
    if (was.state === next.state && was.reason === next.reason && was.version === next.version) return;
    const detail = next.reason ? ` (${next.reason})` : next.state === 'incompatible-version' ? ` (version ${next.version ?? 'unknown'}, expected ${TELEMETRY_VERSION})` : '';
    this.o.log?.(`telemetry (${this.id}): ${next.state}${detail}`);
  }
}

/**
 * Publishes each remote session that enters or leaves the attention list as `needs-you`, with
 * the key `<machine>:<session>`; no local session or account, since the session is not this Mac's.
 */
export function publishRemoteAttentionChanges(cursor: ChangeCursor): (change: RemoteSessionChange) => void {
  return ({ machineId, sessionId }) => {
    cursor.record({ type: 'needs-you', key: `${machineId}:${sessionId}`, sessionId: null, accountId: null });
  };
}
