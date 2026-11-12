// The version of a remote machine's núcleo, as this Mac shows it (issue 449, decision 0021 section 1).
//
// The Mac reads the remote's anonymous `GET /api/overview` (`{ version, commit, pid, ... }`) and compares
// its `version` with its own (`API_VERSION`). The reading is anonymous, so a stranger on the port can
// answer anything: it is shown as a warning and never decides an update (the update command reads git).
// What the remote says is shown only when it has the exact shape below; the raw text never reaches the JSON.

import type { RemoteGetResult } from './ports.ts';

export type CoreStatus = 'current' | 'outdated' | 'ahead' | 'unknown';

/** What this Mac declares to the update command's guard (decision 0021 section 4), plus its checkout path. */
export interface CoreMacDeclaration {
  telemetryVersion: number;
  /** This machine has a valid `connection.credential`, so the Mac can sign in after an update that requires the owner's proof. */
  credentialCommand: boolean;
  /** `connection.checkout` of machines.json (an absolute path), or `null`. */
  checkout: string | null;
}

export interface MachineCore {
  version: string | null;
  commit: string | null;
  expectedVersion: string;
  mac: CoreMacDeclaration;
  status: CoreStatus;
  /** ISO time of the last good read of the remote's overview. */
  readAt: string | null;
}

/**
 * The first app version whose release carries both `scripts/remote-core/update-remote-core.mjs` and
 * `packages/nucleo/remote-contract.json` (decision 0021 section 2). Below it, the screen shows the
 * bootstrap instructions instead of `--ref app-v<version>`, which would not exist there.
 */
export const FIRST_UPDATER_VERSION = '0.0.17';

const VERSION = /^\d+\.\d+\.\d+$/;
const COMMIT = /^[0-9a-f]{4,40}$/;
const MAX_TEXT = 64;

/** `major.minor.patch` as numbers; a prerelease suffix is ignored. `null` when it does not have that shape. */
export function parseSemver(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Negative, zero or positive; `null` when either side is not a version. */
export function compareSemver(a: string, b: string): number | null {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}

/** `true` when this app version carries the update command in its release (decision 0021 section 2). */
export function hasUpdater(appVersion: string): boolean {
  const c = compareSemver(appVersion, FIRST_UPDATER_VERSION);
  return c !== null && c >= 0;
}

export interface ParsedOverview {
  version: string | null;
  commit: string | null;
}

/** The `version` and `commit` of an overview answer, each only when it has its exact shape; anything else is `null`. */
export function parseOverview(r: RemoteGetResult): ParsedOverview | null {
  if (r.kind !== 'response' || r.status !== 200 || typeof r.body !== 'object' || r.body === null || Array.isArray(r.body)) return null;
  const { version, commit } = r.body as Record<string, unknown>;
  return {
    version: typeof version === 'string' && version.length <= MAX_TEXT && VERSION.test(version) ? version : null,
    commit: typeof commit === 'string' && commit.length <= MAX_TEXT && COMMIT.test(commit) ? commit : null,
  };
}

/**
 * The status of the remote against this app. Without a valid remote `version`, `unknown`. Equal versions
 * are `outdated` only when this Mac runs from a checkout (`isOlderCommit` given) and the remote's commit
 * is an older one of it: `package.json` only moves on a release, so equal versions can be different code.
 */
export function coreStatus(remote: ParsedOverview | null, expectedVersion: string, isOlderCommit?: (commit: string) => boolean): CoreStatus {
  if (!remote?.version) return 'unknown';
  const c = compareSemver(remote.version, expectedVersion);
  if (c === null) return 'unknown';
  if (c < 0) return 'outdated';
  if (c > 0) return 'ahead';
  return remote.commit && isOlderCommit?.(remote.commit) ? 'outdated' : 'current';
}
