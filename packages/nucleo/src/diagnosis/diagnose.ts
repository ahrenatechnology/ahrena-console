// The diagnosis use case (#565): reads the machine's open alert, asks the collector port for each
// section of that alert's kind, in parallel, and assembles the `Diagnosis`. It does not decide whether
// there is an alert (the tracker does) and it runs no command (the collector adapters do).
//
// - The timeout is enforced once, here, at the boundary: a race with a timer that is always cleared.
// - A collector that reports unavailable or throws fails its own section only.
// - The mount of a `volume-full` comes from the open alert the tracker holds, never from the request.

import type { Alert } from '../telemetry/model.ts';
import { LIST_CAP, capReason, isDiagnosable, sectionsFor, type Diagnosis, type DiagnosisSection, type ProcessItem, type FolderItem, type SectionId, type SectionItem } from './model.ts';

export interface CollectContext {
  /** The mount of the open `volume-full:<mount>` alert; null for the other kinds. */
  mount: string | null;
}

export type CollectResult = SectionItem[] | { unavailable: true; reason?: string };
export type SectionCollector = (id: SectionId, context: CollectContext) => Promise<CollectResult>;

export interface DiagnoseDeps {
  /** The machine's open alerts; `AlertTracker` satisfies it. */
  alerts: { active(machineId: string): Alert[] };
  isKnownMachine(machineId: string): boolean;
  collect: SectionCollector;
  platform: string;
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

  const context: CollectContext = { mount: alert.kind === 'volume-full' && alert.id.startsWith(VOLUME_PREFIX) ? alert.id.slice(VOLUME_PREFIX.length) : null };
  const takenAt = deps.now();
  const sections = await Promise.all(sectionsFor(alert.kind, deps.platform).map((id) => collectSection(id, context, deps)));
  return { kind: 'ok', diagnosis: { machine: request.machine, alertId: alert.id, kind: alert.kind, takenAt, sections } };
}

async function collectSection(id: SectionId, context: CollectContext, deps: DiagnoseDeps): Promise<DiagnosisSection> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), deps.sectionTimeoutMs);
  });
  try {
    const result = await Promise.race([deps.collect(id, context), timeout]);
    if (result === TIMED_OUT) return { id, status: 'timeout', items: [] };
    if (!Array.isArray(result)) return unavailable(id, result.reason);
    return { id, status: 'ok', items: shape(id, result) };
  } catch (err) {
    return unavailable(id, err instanceof Error ? err.message : undefined);
  } finally {
    clearTimeout(timer);
  }
}

function unavailable(id: SectionId, reason: string | undefined): DiagnosisSection {
  return reason ? { id, status: 'unavailable', items: [], reason: capReason(reason) } : { id, status: 'unavailable', items: [] };
}

/** Sorting and the cap live here, not in the collectors: every machine and OS answers the same way. */
function shape(id: SectionId, items: SectionItem[]): SectionItem[] {
  const top = <T>(list: T[], by: (t: T) => number) => [...list].sort((a, b) => by(b) - by(a)).slice(0, LIST_CAP);
  if (id === 'processes-by-rss') return top(items as ProcessItem[], (p) => p.rssBytes);
  if (id === 'processes-by-cpu') return top(items as ProcessItem[], (p) => p.cpuPct);
  if (id === 'largest-folders') return top(items as FolderItem[], (f) => f.bytes);
  return items;
}
