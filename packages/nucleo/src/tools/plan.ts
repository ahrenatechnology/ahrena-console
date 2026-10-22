// The plan of one action (#280, decision 0014 section 3): the steps built from the catalog for the
// detected source, the target version, the timeout and the `planDigest` the screen sends back with
// the POST (layer 2), so the núcleo refuses to run anything other than what the person confirmed.
//
// - The source of `update`, `start` and `stop` is the detected one; `install` uses the first source of
//   the platform whose manager is present (else the first with an install action, blocked).
// - `{version}` is replaced only with a version matching `VERSION_PATTERN`; anything else leaves the
//   plan with `versionOk: false` and the token in place, and the action is not runnable.
// - `admin` is the entry's mark OR any step whose executable is sudo, doas, pkexec, su, runas or
//   osascript: a forgotten mark is still caught here.

import { createHash } from 'node:crypto';
import {
  DEFAULT_TIMEOUT_SECONDS,
  isAdminExecutable,
  MAX_TIMEOUT_SECONDS,
  sourcesFor,
  VERSION_PATTERN,
  VERSION_TOKEN,
  type ActionId,
  type DetectedSourceId,
  type Platform,
  type SourceId,
  type ToolAction,
  type ToolEntry,
  type ToolSource,
} from './catalog.ts';

export interface PlanDetection {
  installed: string | null;
  sourceId: DetectedSourceId | null;
}

export interface PlanOptions {
  machine?: string;
  arch?: string;
  /** Whether a source's manager is on the login PATH (install picks the first present). */
  hasManager?: (source: ToolSource) => boolean;
}

export interface ToolPlan {
  toolId: string;
  actionId: ActionId;
  sourceId: SourceId;
  source: ToolSource;
  steps: string[][];
  timeoutSeconds: number;
  admin: boolean;
  targetVersion: string | null;
  /** `false` when a step needs a version and there is no valid one: not runnable. */
  versionOk: boolean;
  planDigest: string;
}

/** The source an action runs from, or `null` when the catalog has none for it. */
export function sourceForAction(entry: ToolEntry, actionId: ActionId, detection: PlanDetection, platform: Platform, opts: PlanOptions = {}): ToolSource | null {
  const sources = sourcesFor(entry, platform, opts.arch ?? process.arch).filter((s) => s.actions[actionId]);
  if (actionId === 'install') {
    if (detection.installed !== null) return null;
    return sources.find((s) => opts.hasManager?.(s) ?? true) ?? sources[0] ?? null;
  }
  if (detection.sourceId === null || detection.sourceId === 'manual') return null;
  return sources.find((s) => s.id === detection.sourceId) ?? null;
}

/** The version as a step writes it; `null` when it is not a valid version. */
export function formatVersion(version: string | null, format: ToolAction['versionFormat'] = 'full'): string | null {
  if (version === null || !VERSION_PATTERN.test(version)) return null;
  if (format === 'major.minor') {
    const parts = version.split('.');
    return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : null;
  }
  return version;
}

const needsVersion = (steps: readonly (readonly string[])[]) => steps.some((s) => s.some((a) => a.includes(VERSION_TOKEN)));

/** The steps with `{version}` replaced; `null` when they need a version and `version` is not valid. */
export function substituteVersion(steps: readonly (readonly string[])[], version: string | null, format: ToolAction['versionFormat'] = 'full'): string[][] | null {
  if (!needsVersion(steps)) return steps.map((s) => [...s]);
  const v = formatVersion(version, format);
  if (v === null) return null;
  return steps.map((s) => s.map((a) => a.split(VERSION_TOKEN).join(v)));
}

export function planDigest(p: { machine: string; toolId: string; actionId: string; sourceId: string; steps: readonly (readonly string[])[]; timeoutSeconds: number }): string {
  // Fixed key order: the same plan always gives the same digest.
  const canonical = JSON.stringify({ machine: p.machine, toolId: p.toolId, actionId: p.actionId, sourceId: p.sourceId, steps: p.steps, timeoutSeconds: p.timeoutSeconds });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

export function buildPlan(entry: ToolEntry, actionId: ActionId, detection: PlanDetection, latest: string | null, platform: Platform, opts: PlanOptions = {}): ToolPlan | null {
  const source = sourceForAction(entry, actionId, detection, platform, opts);
  const action = source?.actions[actionId];
  if (!source || !action) return null;
  const built = substituteVersion(action.steps, latest, action.versionFormat);
  const steps = built ?? action.steps.map((s) => [...s]);
  const timeoutSeconds = Math.min(Math.max(1, action.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS), MAX_TIMEOUT_SECONDS);
  const admin = action.admin === true || steps.some((s) => isAdminExecutable(s[0] ?? ''));
  const usesVersion = needsVersion(action.steps);
  const machine = opts.machine ?? 'local';
  return {
    toolId: entry.id,
    actionId,
    sourceId: source.id,
    source,
    steps,
    timeoutSeconds,
    admin,
    targetVersion: actionId === 'start' || actionId === 'stop' ? null : formatVersion(latest),
    versionOk: !usesVersion || built !== null,
    planDigest: planDigest({ machine, toolId: entry.id, actionId, sourceId: source.id, steps, timeoutSeconds }),
  };
}
