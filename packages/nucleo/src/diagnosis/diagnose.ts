// The diagnosis use case (#565): reads the machine's open alert, asks the collector port for each
// section of that alert's kind, in parallel, and assembles the `Diagnosis`. It does not decide whether
// there is an alert (the tracker does) and it runs no command (the collector adapters do).
//
// - The timeout is enforced once, here, at the boundary: a race with a timer that is always cleared.
// - A collector that reports unavailable or throws fails its own section only.
// - The mount of a `volume-full` comes from the open alert the tracker holds, never from the request.

import type { Alert, HostInfo } from '../telemetry/model.ts';
import { LIST_CAP, capReason, isDiagnosable, sectionsFor, type CacheItem, type Diagnosis, type DiagnosisSection, type DockerDfItem, type FolderItem, type JournalItem, type ProcessItem, type SectionId, type SwapItem, type WorktreeItem } from './model.ts';

export interface CollectContext {
  /** The mount of the open `volume-full:<mount>` alert; null for the other kinds (#565). */
  mount: string | null;
  /** Aborted when the section ends, by timeout or not: a collector that runs a command stops it (#565). */
  signal: AbortSignal;
}

/** What each section's collector returns, so the use case shapes by id with no cast (#565). */
export interface SectionItems {
  'processes-by-rss': ProcessItem[];
  'processes-by-cpu': ProcessItem[];
  swap: SwapItem[];
  'largest-folders': FolderItem[];
  'docker-df': DockerDfItem[];
  'known-caches': (CacheItem | WorktreeItem)[];
  journal: JournalItem[];
}

export type CollectResult<K extends SectionId> = SectionItems[K] | { unavailable: true; reason?: string };
export type SectionCollector = <K extends SectionId>(id: K, context: CollectContext) => Promise<CollectResult<K>>;

export interface DiagnoseDeps {
  /** The machine's open alerts; `AlertTracker` satisfies it (#565). */
  alerts: { active(machineId: string): Alert[] };
  isKnownMachine(machineId: string): boolean;
  collect: SectionCollector;
  platform: HostInfo['platform'];
  log(message: string): void;
  now(): string;
  sectionTimeoutMs: number;
}

export type DiagnoseResult =
  | { kind: 'ok'; diagnosis: Diagnosis }
  | { kind: 'unknown-machine' }
  | { kind: 'alert-not-open' }
  | { kind: 'not-diagnosable' };

const VOLUME_PREFIX = 'volume-full:';
const TIMED_OUT = Symbol('timed-out');

export async function diagnose(request: { machine: string; alertId: string }, deps: DiagnoseDeps): Promise<DiagnoseResult> {
  if (!deps.isKnownMachine(request.machine)) return { kind: 'unknown-machine' };
  const alert = deps.alerts.active(request.machine).find((a) => a.id === request.alertId);
  if (!alert) return { kind: 'alert-not-open' };
  if (!isDiagnosable(alert.kind)) return { kind: 'not-diagnosable' };

  const context: Omit<CollectContext, 'signal'> = { mount: alert.kind === 'volume-full' && alert.id.startsWith(VOLUME_PREFIX) ? alert.id.slice(VOLUME_PREFIX.length) : null };
  const takenAt = deps.now();
  const sections = await Promise.all(sectionsFor(alert.kind, deps.platform).map((id) => collectSection(id, request.machine, context, deps)));
  return { kind: 'ok', diagnosis: { machine: request.machine, alertId: alert.id, kind: alert.kind, takenAt, sections } };
}

async function collectSection<K extends SectionId>(id: K, machine: string, context: Omit<CollectContext, 'signal'>, deps: DiagnoseDeps): Promise<DiagnosisSection> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), deps.sectionTimeoutMs);
  });
  try {
    const result = await Promise.race([deps.collect(id, { ...context, signal: controller.signal }), timeout]);
    if (result === TIMED_OUT) return { id, status: 'timeout', items: [] };
    if (!Array.isArray(result)) return unavailable(id, result.reason);
    return { id, status: 'ok', items: shape(id, result) };
  } catch (err) {
    deps.log(`diagnosis section ${id} failed on ${machine}: ${err}`);
    return unavailable(id, err instanceof Error ? err.message : undefined);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function unavailable(id: SectionId, reason: string | undefined): DiagnosisSection {
  return reason ? { id, status: 'unavailable', items: [], reason: capReason(reason) } : { id, status: 'unavailable', items: [] };
}

function top<T>(list: T[], by: (item: T) => number): T[] {
  return [...list].sort((a, b) => by(b) - by(a)).slice(0, LIST_CAP);
}

/** The sort key of each section that is ranked; the others keep the collector's order (#565). */
type Rankers = { [K in SectionId]?: (item: SectionItems[K][number]) => number };
const RANKERS: Rankers = {
  'processes-by-rss': (p) => p.rssBytes,
  'processes-by-cpu': (p) => p.cpuPct,
  'largest-folders': (f) => f.bytes,
};

/** Sorting and the cap live here, not in the collectors: every machine and OS answers the same way (#565). */
function shape<K extends SectionId>(id: K, items: SectionItems[K]): SectionItems[K][number][] {
  const by: Rankers[K] = RANKERS[id];
  return by ? top(items, by) : items;
}
