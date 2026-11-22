/*
 * The read-only diagnosis of a saturation alert (#565, epic #563): what the núcleo of the saturated
 * machine reports about who consumes the resource that saturated. Pure vocabulary: no command, no file,
 * no network lives here; the collectors that read the machine are the next layer's.
 *
 * - The section ids are fixed (AC-8); the screen and the delegation key on them.
 * - Old worktrees have no section of their own (AC-8 lists none): each one is an item of `known-caches`,
 *   with `id: 'worktree'` and `actionId: null` (no cleanup action removes a worktree).
 * - A section that did not come carries `status` and a short `reason`, never an empty list pretending to be data.
 * - A section that came but was read only in part (a folder that could not be fully read) is `ok`, with its items
 *   and a `partial` marker with a short reason; an `ok` section whole carries no marker.
 * - `processes-by-session` (issue 722, epic 720) says which agent session the load belongs to: up to `LIST_CAP`
 *   sessions by summed CPU, and the processes that descend from no session as one `outsideSession` line apart from the list.
 * - An `ok` `known-caches` section also carries `worktrees`, the two facts the screen words its worktree line from
 *   (age limit in days, shared root folder), so the screen never guesses them (#566).
 */

import type { AlertKind, HostInfo } from '../telemetry/model.ts';

export const SECTION_IDS = ['processes-by-rss', 'processes-by-cpu', 'processes-by-session', 'swap', 'largest-folders', 'docker-df', 'known-caches', 'journal'] as const;
export type SectionId = (typeof SECTION_IDS)[number];

export const SECTION_STATUSES = ['ok', 'unavailable', 'timeout'] as const;
export type SectionStatus = (typeof SECTION_STATUSES)[number];

/** The most items a list section carries (processes, folders). */
export const LIST_CAP = 10;
/** The longest `reason`: short, because the screen shows it in one line. */
export const REASON_MAX = 120;

/** The ids of the cleanup actions of #569 that a known cache points to (AC-11). */
export const CACHE_ACTION_IDS = { npm: 'npm-cache', pip: 'pip-cache', xcodeDerivedData: 'xcode-derived-data' } as const;
export type CacheActionId = (typeof CACHE_ACTION_IDS)[keyof typeof CACHE_ACTION_IDS];

export interface ProcessItem {
  pid: number;
  name: string;
  rssBytes: number;
  cpuPct: number;
  startedAt: string;
}
/** The load of one agent session: the processes that descend from it, their count and summed CPU (issue 722). */
export interface SessionLoadItem {
  sessionId: string;
  /** The session's title as the console knows it; `null` when it knows none. */
  title: string | null;
  /** What the session is running, short and without arguments: `pnpm test` (see `rootCommandOf`). */
  rootCommand: string;
  cwd: string | null;
  processCount: number;
  cpuPct: number;
}
/** The processes that descend from no live registered session, as one line (issue 722). */
export interface OutsideSessionLoad {
  processCount: number;
  cpuPct: number;
}
export interface SwapItem {
  usedBytes: number;
  totalBytes: number;
}
export interface FolderItem {
  path: string;
  bytes: number;
}
/** One row of `docker system df`. */
export interface DockerDfItem {
  type: string;
  usedBytes: number;
  reclaimableBytes: number;
}
export interface CacheItem {
  id: string;
  path: string;
  bytes: number;
  actionId: CacheActionId;
}
export interface WorktreeItem {
  id: 'worktree';
  path: string;
  bytes: number;
  lastUsedAt: string;
  hasUncommitted: boolean;
  hasUnpushed: boolean;
  actionId: null;
}
/** The facts about the old worktrees of a `known-caches` section: the limit in whole days after which one is old, and the shared parent of the roots searched, `~` for this core's home, `null` for none (#566). */
export interface WorktreesInfo {
  oldAfterDays: number;
  root: string | null;
}
export interface JournalItem {
  bytes: number;
}

/** What each section carries, keyed by section id: the one place that says which items go with which section (#565). */
export interface SectionItems {
  'processes-by-rss': ProcessItem[];
  'processes-by-cpu': ProcessItem[];
  'processes-by-session': SessionLoadItem[];
  swap: SwapItem[];
  'largest-folders': FolderItem[];
  'docker-df': DockerDfItem[];
  'known-caches': (CacheItem | WorktreeItem)[];
  journal: JournalItem[];
}

/** Marks an `ok` section whose items were read only in part; `reason` is short, like the others (#565). */
export interface PartialMarker {
  reason: string;
}

/** A section of one id, with the items of that id; the union over all ids narrows on `id` (#565). */
export type SectionOf<K extends SectionId> = { [P in K]: { id: P; status: SectionStatus; items: SectionItems[P]; reason?: string; partial?: PartialMarker; worktrees?: WorktreesInfo; outsideSession?: OutsideSessionLoad } }[K];
export type DiagnosisSection = SectionOf<SectionId>;

export interface Diagnosis {
  machine: string;
  alertId: string;
  kind: AlertKind;
  takenAt: string;
  sections: DiagnosisSection[];
}

const SECTIONS_BY_KIND: Partial<Record<AlertKind, readonly SectionId[]>> = {
  'load-high': ['processes-by-cpu', 'processes-by-session'],
  'memory-high': ['processes-by-rss', 'processes-by-cpu', 'swap'],
  'swap-high': ['processes-by-rss', 'processes-by-cpu', 'swap'],
  'volume-full': ['largest-folders', 'docker-df', 'known-caches'],
};

export function isDiagnosable(kind: AlertKind): boolean {
  return kind in SECTIONS_BY_KIND;
}

/** The sections an alert kind gets, in the fixed order; the journal only exists on Linux. */
export function sectionsFor(kind: AlertKind, platform: HostInfo['platform']): SectionId[] {
  const sections = [...(SECTIONS_BY_KIND[kind] ?? [])];
  if (kind === 'volume-full' && platform === 'linux') sections.push('journal');
  return sections;
}

export function capReason(reason: string): string {
  return reason.length > REASON_MAX ? reason.slice(0, REASON_MAX) : reason;
}
