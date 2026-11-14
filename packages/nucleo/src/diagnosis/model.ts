// The read-only diagnosis of a saturation alert (#565, epic #563): what the núcleo of the saturated
// machine reports about who consumes the resource that saturated. Pure vocabulary: no command, no file,
// no network lives here; the collectors that read the machine are the next layer's.
//
// - The section ids are fixed (AC-8); the screen and the delegation key on them.
// - Old worktrees have no section of their own (AC-8 lists none): each one is an item of `known-caches`,
//   with `id: 'worktree'` and `actionId: null` (no cleanup action removes a worktree).
// - A section that did not come carries `status` and a short `reason`, never an empty list pretending to be data.

import type { AlertKind } from '../telemetry/model.ts';

export const SECTION_IDS = ['processes-by-rss', 'processes-by-cpu', 'swap', 'largest-folders', 'docker-df', 'known-caches', 'journal'] as const;
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
export interface JournalItem {
  bytes: number;
}
export type SectionItem = ProcessItem | SwapItem | FolderItem | DockerDfItem | CacheItem | WorktreeItem | JournalItem;

export interface DiagnosisSection {
  id: SectionId;
  status: SectionStatus;
  items: SectionItem[];
  reason?: string;
}

export interface Diagnosis {
  machine: string;
  alertId: string;
  kind: AlertKind;
  takenAt: string;
  sections: DiagnosisSection[];
}

const SECTIONS_BY_KIND: Partial<Record<AlertKind, readonly SectionId[]>> = {
  'load-high': ['processes-by-cpu'],
  'memory-high': ['processes-by-rss', 'processes-by-cpu', 'swap'],
  'swap-high': ['processes-by-rss', 'processes-by-cpu', 'swap'],
  'volume-full': ['largest-folders', 'docker-df', 'known-caches'],
};

export function isDiagnosable(kind: AlertKind): boolean {
  return kind in SECTIONS_BY_KIND;
}

/** The sections an alert kind gets, in the fixed order; the journal only exists on Linux. */
export function sectionsFor(kind: AlertKind, platform: string): SectionId[] {
  const sections = [...(SECTIONS_BY_KIND[kind] ?? [])];
  if (kind === 'volume-full' && platform === 'linux') sections.push('journal');
  return sections;
}

export function capReason(reason: string): string {
  return reason.length > REASON_MAX ? reason.slice(0, REASON_MAX) : reason;
}
