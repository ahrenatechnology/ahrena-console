// The desktop app's update notice (issue #330, wireframes C77 to C80, A11, A12).
//
// The app checks the update channel; the núcleo only receives and publishes the state, so the /ui
// (a window, a browser, the claude.ai artifact) can show the same card:
//
// - The app reports with `report()` (`PUT /api/app-update/state`, a local request without `Origin`): the
//   version it runs, its mode, what it found, the phase of a download, when it checked and when it
//   checks next. A núcleo no app ever reported to (the Claude Desktop extension, an app from before
//   #330) has `app: false`: nobody checks the channel, so there is nothing to show.
// - The person acts with `act()`: `check` and `install` become a counter in the state that the app
//   sees through `GET /api/changes` and carries out; `dismiss` (Depois) and `ack` (the "updated" card)
//   the núcleo keeps itself, for every window.
// - Depois hides the card until a newer version comes out or for 24 h, whichever comes first, and the
//   macOS notification never repeats for the same version (the app keeps that one).
// - Nothing here is persisted: the núcleo restarts together with the app, which reports again.

import type { ChangeCursor } from '../changes/cursor.ts';

export const DISMISS_MS = 24 * 60 * 60 * 1000;
export const APP_UPDATE_PHASES = ['idle', 'checking', 'downloading', 'installing', 'error'] as const;
export type AppUpdatePhase = (typeof APP_UPDATE_PHASES)[number];
export const APP_UPDATE_MODES = ['dev', 'stable'] as const;
export type AppUpdateMode = (typeof APP_UPDATE_MODES)[number];
/** Why the last manual check or download failed; only a check the person asked for shows it. */
export const APP_UPDATE_ERRORS = ['offline', 'channel-down', 'signature', 'download'] as const;
export type AppUpdateError = (typeof APP_UPDATE_ERRORS)[number];
export const APP_UPDATE_ACTIONS = ['check', 'install', 'dismiss', 'ack'] as const;
export type AppUpdateAction = (typeof APP_UPDATE_ACTIONS)[number];

export interface AvailableUpdate {
  version: string;
  /** The first line of the `latest.json` notes, if any. */
  notes: string | null;
  publishedAt: string | null;
}

export interface AppUpdateReport {
  appVersion: string;
  mode: AppUpdateMode;
  available: AvailableUpdate | null;
  phase: AppUpdatePhase;
  progress: { done: number; total: number | null } | null;
  error: AppUpdateError | null;
  /** Epoch ms of the last check that ended, and of the next scheduled one. */
  lastCheckAt: number | null;
  nextCheckAt: number | null;
  /** Set once, on the first report after the app restarted into a new version. */
  updatedFrom: string | null;
  updatedNotes: string | null;
}

export interface AppUpdateView {
  /** Whether a desktop app reported to this núcleo. Without it there is no card, no dot. */
  app: boolean;
  appVersion: string | null;
  mode: AppUpdateMode | null;
  available: AvailableUpdate | null;
  /** The person pressed Depois for this version and the 24 h are not over. */
  dismissed: boolean;
  phase: AppUpdatePhase;
  progress: AppUpdateReport['progress'];
  error: AppUpdateError | null;
  lastCheckAt: number | null;
  nextCheckAt: number | null;
  /** The "updated" card: shown until acknowledged. */
  updated: { from: string; to: string; notes: string | null } | null;
  /** Counters the app compares with the last it carried out. */
  requests: { check: number; install: number };
}

const EMPTY: AppUpdateReport = { appVersion: '', mode: 'dev', available: null, phase: 'idle', progress: null, error: null, lastCheckAt: null, nextCheckAt: null, updatedFrom: null, updatedNotes: null };

export class AppUpdateState {
  private report_: AppUpdateReport | null = null;
  private dismissedVersion: string | null = null;
  private dismissedAt = 0;
  private updated: { from: string; to: string; notes: string | null } | null = null;
  private readonly requests = { check: 0, install: 0 };

  private readonly cursor: ChangeCursor | null;
  private readonly now: () => number;

  constructor(cursor: ChangeCursor | null, now: () => number = Date.now) {
    this.cursor = cursor;
    this.now = now;
  }

  report(r: AppUpdateReport): void {
    const first = this.report_ === null;
    this.report_ = { ...EMPTY, ...r };
    if (first && r.updatedFrom) this.updated = { from: r.updatedFrom, to: r.appVersion, notes: r.updatedNotes };
    this.changed();
  }

  act(action: AppUpdateAction, version?: string): boolean {
    if (action === 'check' || action === 'install') {
      if (!this.report_) return false;
      this.requests[action]++;
    } else if (action === 'dismiss') {
      const available = this.report_?.available;
      if (!available || (version !== undefined && version !== available.version)) return false;
      this.dismissedVersion = available.version;
      this.dismissedAt = this.now();
    } else {
      this.updated = null;
    }
    this.changed();
    return true;
  }

  view(): AppUpdateView {
    const r = this.report_;
    const available = r?.available ?? null;
    const dismissed = available !== null && this.dismissedVersion === available.version && this.now() - this.dismissedAt < DISMISS_MS;
    return {
      app: r !== null,
      appVersion: r?.appVersion ?? null,
      mode: r?.mode ?? null,
      available,
      dismissed,
      phase: r?.phase ?? 'idle',
      progress: r?.progress ?? null,
      error: r?.error ?? null,
      lastCheckAt: r?.lastCheckAt ?? null,
      nextCheckAt: r?.nextCheckAt ?? null,
      updated: this.updated,
      requests: { ...this.requests },
    };
  }

  private changed(): void {
    this.cursor?.record({ type: 'app-update', key: 'app', sessionId: null, accountId: null });
  }
}
