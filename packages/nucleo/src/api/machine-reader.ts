// Reading a remote núcleo's screen routes for the lists of every machine (#243). The route that merges
// them is api/machine-sessions.ts; this module only fetches, through the `RemoteGet` of #176.
//
// - `GET` only, through `RemoteGet` (adapters/loopback-http.ts: 127.0.0.1, the remote's own Host,
//   no Origin, a body cap). Nothing here writes to the remote.
// - Only from a remote whose state is `connected` (the 30 s poll of telemetry/remote.ts decides it):
//   a machine that is down or of another version is not even asked.
// - An answer never waits more than `timeoutMs` (3 s) for a remote. A read that takes longer is not
//   dropped: it goes on, one at a time per path, up to the adapter's deadline (60 s in cli.ts), and
//   lands in the cache for the next call; meanwhile the path's last 200 answer is used while it is
//   younger than `staleMs` (30 s) or three times what that read took. A remote's Dashboard can take
//   far longer than 3 s to build (about 25 s on the first real Workstation).
// - A short cache per machine, port and path (`ttlMs`, 5 s by default, or twice the time the read
//   took when longer) that also joins reads in flight: the screens and the mod polling the same route
//   make one request to the remote per window, and a slow route is not asked again at once.
//   A failed read is cached too, so a remote that stopped answering is not asked again at once.
// - The result is the parsed JSON of a 200 answer, or `null` (any other status, a body that is not
//   JSON, a timeout, the machine not connected). Nothing here validates the shape: the merge does.
// - `connection(machine)` (#319): the remote's connection as the mod's P14 band reads it,
//   `{ state, since, lastError }`, from the injected `connectionOf`: #278's `MachineConnection.status`,
//   the same `connection` as `GET /api/machines`. `null` without one (the demo, no reconnect runner).

import type { ConnectionStatus } from '../telemetry/model.ts';
import type { RemoteGet } from '../telemetry/ports.ts';
import type { MachineStatus } from '../telemetry/service.ts';
import type { PanelMachineConnection } from './types.ts';

/** The source of a remote's connection: #278's `MachineConnection.status(id)`; `null` when it has none. */
export type ConnectionOf = (machineId: string) => Promise<ConnectionStatus | null> | null;

/** #278's connection as the panel carries it: `{ state, since, lastError }` only; `null` without one. */
export function panelConnection(c: ConnectionStatus | null | undefined): PanelMachineConnection | null {
  if (!c) return null;
  const e = c.lastError;
  return { state: c.state, since: c.since, lastError: e ? { reason: e.reason, at: e.at, exitCode: e.exitCode, holder: e.holder } : null };
}

/** A remote machine as this reader needs it (`RemoteMachine` in production). */
export interface RemoteSessionSource {
  readonly id: string;
  readonly label: string;
  readonly port: number;
  status(): MachineStatus;
}

export interface MachineReaderOptions {
  get: RemoteGet;
  /** The remote machines of machines.json, live (#244). */
  machines: () => readonly RemoteSessionSource[];
  now?: () => number;
  /** How long an answer (or a failure) is reused. Default 5 s. */
  ttlMs?: number;
  /** The most an answer waits for one read. Default 3 s. */
  timeoutMs?: number;
  /**
   * A read that misses `timeoutMs` goes on (up to the adapter's own deadline) and lands in the cache;
   * meanwhile the last 200 answer of that path is used, if it is younger than this (or three times
   * what that read took). Default 30 s.
   */
  staleMs?: number;
  /** At most this many cached paths; the oldest go first. Default 500. */
  maxEntries?: number;
  /** #319: the remote's connection for the panel's `machine` (#278's); without it, `null`. */
  connectionOf?: ConnectionOf | null;
}

export const MACHINE_READ_TTL_MS = 5_000;
export const MACHINE_READ_TIMEOUT_MS = 3_000;
export const MACHINE_READ_STALE_MS = 30_000;
/** The adapter's deadline for a remote read (cli.ts): a slow route still lands in the cache. */
export const MACHINE_READ_ADAPTER_TIMEOUT_MS = 60_000;
const MAX_ENTRIES = 500;

/** A remote's HTTP answer: the status and the parsed JSON (`undefined` when the body was not JSON). */
export interface RemoteAnswer {
  status: number;
  body: unknown;
}

interface Entry {
  promise: Promise<{ answer: RemoteAnswer | null }>;
  startedAt: number;
  /** When the read ended; `null` while in flight. */
  settledAt: number | null;
}

/** `null` after `ms`, unless `promise` settles first. Never rejects. */
export function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

export class MachineReader {
  private readonly o: MachineReaderOptions;
  /** Per machine, port and path: the read in flight or the last one, and when it ended. */
  private readonly reads = new Map<string, Entry>();
  /** Per machine, port and path: the last 200 answer, for a read that misses the deadline (`staleMs`). */
  private readonly good = new Map<string, { answer: RemoteAnswer; at: number; tookMs: number }>();
  /** How many `GET`s reached the adapter (for the tests). */
  requests = 0;

  constructor(options: MachineReaderOptions) {
    this.o = options;
  }

  get timeoutMs(): number {
    return this.o.timeoutMs ?? MACHINE_READ_TIMEOUT_MS;
  }

  /** The remote machines, in machines.json order. */
  machines(): readonly RemoteSessionSource[] {
    return this.o.machines();
  }

  find(id: string): RemoteSessionSource | undefined {
    return this.o.machines().find((m) => m.id === id);
  }

  /** The machine's connection, `{ state, since, lastError }` only (never a command or a log path); `null` without one. */
  async connection(machine: RemoteSessionSource): Promise<PanelMachineConnection | null> {
    let c: ConnectionStatus | null = null;
    try {
      c = (await this.o.connectionOf?.(machine.id)) ?? null;
    } catch {
      // A source that fails leaves no connection: the panel never fails for it.
    }
    return panelConnection(c);
  }

  /** The JSON of `GET <path>` on the machine when it answered 200, or `null` (see the module comment). */
  async read(machine: RemoteSessionSource, path: string): Promise<unknown> {
    const r = await this.answer(machine, path);
    return r && r.status === 200 && r.body !== undefined ? r.body : null;
  }

  /** The machine's answer to `GET <path>`, any status; `null` when there was none or it is not connected. */
  async answer(machine: RemoteSessionSource, path: string): Promise<RemoteAnswer | null> {
    if (machine.status().state !== 'connected') return null;
    const now = this.now();
    const key = `${machine.id}\0${machine.port}\0${path}`;
    let entry = this.reads.get(key);
    if (!entry || this.expired(entry, now)) {
      const fresh: Entry = { promise: Promise.resolve({ answer: null }), startedAt: now, settledAt: null };
      this.requests++;
      fresh.promise = this.o.get(machine.port, path).then(
        (r) => this.settle(key, fresh, r.kind === 'response' ? { status: r.status, body: r.body } : null),
        () => this.settle(key, fresh, null),
      );
      this.reads.delete(key);
      this.reads.set(key, fresh);
      this.prune(now);
      entry = fresh;
    }
    const outcome = await withDeadline(entry.promise, this.timeoutMs);
    if (outcome) return outcome.answer;
    // Past the deadline the read goes on, for the next call; meanwhile, a recent good answer.
    const last = this.good.get(key);
    return last && now - last.at < this.staleFor(last.tookMs) ? last.answer : null;
  }

  private get ttl(): number {
    return this.o.ttlMs ?? MACHINE_READ_TTL_MS;
  }

  /**
   * A read is reused for `ttlMs`, or for twice what it took when that is longer: a route that keeps
   * the remote busy for 10 s (a cold Dashboard) is asked again only 20 s later, so polling never keeps
   * the remote núcleo busy more than a third of the time.
   */
  private expired(e: Entry, now: number): boolean {
    return e.settledAt !== null && now - e.settledAt >= Math.max(this.ttl, 2 * (e.settledAt - e.startedAt));
  }

  /** How long a good answer stands in for a late read: `staleMs`, or three times what it took (reused twice that, then read again). */
  private staleFor(tookMs: number): number {
    return Math.max(this.o.staleMs ?? MACHINE_READ_STALE_MS, 3 * tookMs);
  }

  now(): number {
    return (this.o.now ?? Date.now)();
  }

  private settle(key: string, entry: Entry, answer: RemoteAnswer | null): { answer: RemoteAnswer | null } {
    const at = this.now();
    entry.settledAt = at;
    if (answer && answer.status === 200 && answer.body !== undefined) {
      this.good.delete(key);
      this.good.set(key, { answer, at, tookMs: at - entry.startedAt });
    }
    return { answer };
  }

  private prune(now: number): void {
    const max = this.o.maxEntries ?? MAX_ENTRIES;
    for (const [key, e] of this.reads) if (this.expired(e, now)) this.reads.delete(key);
    for (const [key, g] of this.good) if (now - g.at >= this.staleFor(g.tookMs)) this.good.delete(key);
    for (const map of [this.reads, this.good] as Map<string, unknown>[]) {
      for (const key of map.keys()) {
        if (map.size <= max) break;
        map.delete(key);
      }
    }
  }
}

