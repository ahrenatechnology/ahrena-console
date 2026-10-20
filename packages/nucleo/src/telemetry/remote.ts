// A remote machine (#176, decision 0008 sections 2 and 3): another núcleo, reached through the local
// port the user's tunnel forwards. Every 30 s (and once on start) this Mac's núcleo asks it for
// `GET /api/telemetry` and, when that answers, `GET /api/attention`, through `RemoteGet`.
//
// - The state: `connected`; `unreachable` with the reason (`port-closed`, `no-response`);
//   `incompatible-version` when the `version` of its telemetry is not this one's (or it has no
//   telemetry route at all). Until the first read ends, `unreachable` with no reason.
// - The newest reading goes into the same `TelemetryStore`, under the remote's id: the screen opens
//   with it, and with its age, while the machine is down.
// - The alerts: the ones the remote computed over its own samples, plus `machine-unreachable`
//   ("Workstation sem conexão") while it cannot be read. Each one that enters or exits is published,
//   like this machine's (sampler.ts), so a machine that goes down or comes back reaches `/api/changes`.
// - Its sessions that need you: the remote's attention answer, kept while connected and handed to
//   the attention route (api/rota-atencao.ts), which marks them with this machine. A session that
//   enters or leaves it is published too, so the tray refreshes.
// - `GET` only, never overlapping, injectable timers and clock; in tests, `pollOnce()` directly.

import type { CursorDeMudancas } from '../mudancas/cursor.ts';
import { machineUnreachableAlert, type AlertChange, type AlertTracker } from './alerts.ts';
import type { RemoteMachineConfig } from './machines-config.ts';
import { RETENTION_MS, SAMPLE_INTERVAL_MS, TELEMETRY_VERSION, type Alert, type MachineState, type TelemetryReading } from './model.ts';
import type { RemoteGet, TelemetryStore } from './ports.ts';
import { systemTimers, type SamplerTimers } from './sampler.ts';
import type { MachineEntry, MachineStatus } from './service.ts';

export const REMOTE_TELEMETRY_PATH = '/api/telemetry';
/** The remote núcleo's attention route (src/api/rota-atencao.ts `ATTENTION_ROUTE`). */
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

/**
 * Enough of a reading to store it: what `samplePointOf` reads, with the types the `telemetry_samples`
 * columns require. The rest is kept as the remote sent it.
 */
export function isStorableReading(v: unknown): v is TelemetryReading {
  if (!isObject(v) || typeof v.takenAt !== 'string' || !Number.isFinite(Date.parse(v.takenAt))) return false;
  const { cpu, memory, disk, network, gpu } = v;
  if (!isObject(cpu) || !Number.isInteger(cpu.cores) || !isNumberOrNull(cpu.usedPct) || !isObject(cpu.load) || !isNumber(cpu.load.one)) return false;
  if (!isObject(memory) || !isNumber(memory.usedBytes) || !isNumberOrNull(memory.swapUsedBytes)) return false;
  if (!isObject(disk) || !Array.isArray(disk.volumes)) return false;
  if (network !== null && !(isObject(network) && isNumberOrNull(network.rxBytesPerSec) && isNumberOrNull(network.txBytesPerSec))) return false;
  if (gpu !== null && !(isObject(gpu) && isNumberOrNull(gpu.usedPct))) return false;
  return true;
}

/** The remote's own alerts that have the alert shape; `machine-unreachable` is this Mac's to compute. */
export function remoteAlerts(v: unknown): Alert[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (a): a is Alert =>
      isObject(a) &&
      typeof a.id === 'string' &&
      a.id !== 'machine-unreachable' &&
      typeof a.kind === 'string' &&
      (a.level === 'error' || a.level === 'warning') &&
      typeof a.message === 'string' &&
      (a.detail === null || typeof a.detail === 'string') &&
      typeof a.since === 'string',
  );
}

/** The sessions in a remote attention answer, by id (for what entered and left). */
function attentionSessions(body: unknown): Set<string> {
  const items = isObject(body) && Array.isArray(body.itens) ? body.itens : [];
  return new Set(items.flatMap((i) => (isObject(i) && typeof i.sessao === 'string' ? [`${i.sessao}:${String(i.motivo)}`] : [])));
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
      const reading = t.body.current;
      if (isStorableReading(reading)) {
        try {
          await store.putSample(this.id, reading, this.o.retentionMs ?? RETENTION_MS);
        } catch (err) {
          this.o.log?.(`telemetry (${this.id}): ${(err as Error).message}`);
        }
      }
      alerts = remoteAlerts(t.body.alerts);
      const a = await get(this.port, REMOTE_ATTENTION_PATH);
      attention = a.kind === 'response' && a.status === 200 && isObject(a.body) ? a.body : null;
    }
    if (next.state === 'unreachable' && next.reason) alerts.push(machineUnreachableAlert(this.label, this.port, next.reason, new Date(now).toISOString()));

    this.logTransition(next);
    this.current = next;
    this.publishAttention(attention);
    const update = tracker.update(this.id, alerts);
    for (const alert of update.entered) this.o.onAlertChange?.({ machineId: this.id, alert, change: 'entered' });
    for (const alert of update.exited) this.o.onAlertChange?.({ machineId: this.id, alert, change: 'exited' });
    return next;
  }

  private publishAttention(next: unknown): void {
    const before = attentionSessions(this.lastAttention);
    const after = attentionSessions(next);
    this.lastAttention = next;
    const changed = new Set<string>();
    for (const k of before) if (!after.has(k)) changed.add(k.slice(0, k.lastIndexOf(':')));
    for (const k of after) if (!before.has(k)) changed.add(k.slice(0, k.lastIndexOf(':')));
    for (const sessionId of changed) this.o.onAttentionChange?.({ machineId: this.id, sessionId });
  }

  private logTransition(next: MachineStatus): void {
    const was = this.current;
    if (was.state === next.state && was.reason === next.reason && was.version === next.version) return;
    const detail = next.reason ? ` (${next.reason})` : next.state === 'incompatible-version' ? ` (version ${next.version ?? 'unknown'}, expected ${TELEMETRY_VERSION})` : '';
    this.o.log?.(`telemetry (${this.id}): ${next.state}${detail}`);
  }
}

/**
 * Publishes each remote session that enters or leaves the attention list as `precisa-de-voce`, with
 * the key `<machine>:<session>`; no local session or account, since the session is not this Mac's.
 */
export function publishRemoteAttentionChanges(cursor: CursorDeMudancas): (change: RemoteSessionChange) => void {
  return ({ machineId, sessionId }) => {
    cursor.registrar({ tipo: 'precisa-de-voce', chave: `${machineId}:${sessionId}`, sessionId: null, accountId: null });
  };
}
