import { StringDecoder } from 'node:string_decoder';

// What the Mac's núcleo knows of the update script's contract, as pure functions (issue 462, decision 0022
// sections 1, 4, 6 and 7); the job that runs it is telemetry/core-update.ts.
//
// - `buildTail`: the CLOSED tail of the argv the núcleo appends to the declared `connection.update` command.
//   Each value is pinned by a regex without shell metacharacters, because `ssh` joins the argv and the remote
//   login shell reads it again (decision 0022 section 1). No text of the screen, the URL or the body reaches it.
// - `ProgressParser`: the NDJSON the script writes on stdout under `--progress json`. Closed: at most 64 KiB in
//   all, one JSON per line, `v: 1`, phases and reasons from closed lists, commits and paths in a fixed shape.
//   A line outside the schema is ignored. The DECISION is the ssh exit code, never the events: the events only
//   give the phase, the reason and the backup path (and a result whose `exit` differs from ssh's is not trusted).
// - `classify`: the exit code (and what is known of the run) to the state and the text key the screen reads.

/** At most this much stdout from the command; past it the run is cut (before the swap) or its output ignored (after). */
export const MAX_UPDATE_OUTPUT_BYTES = 64 * 1024;

export const UPDATE_REF = /^app-v\d+\.\d+\.\d+$/;
const TELEMETRY_VERSION_ARG = /^\d{1,6}$/;
const COMMIT = /^[0-9a-f]{4,40}$/;
const MAX_BACKUP_LENGTH = 512;

export const UPDATE_PHASES = ['check', 'backup', 'swap', 'start', 'verify', 'rollback'] as const;
export type UpdatePhase = (typeof UPDATE_PHASES)[number];

/** The reasons the script gives, per exit code (decision 0022 section 4). */
export const UPDATE_REASONS: Record<number, readonly string[]> = {
  30: ['dirty-tree', 'unknown-ref', 'new-dependencies', 'not-a-checkout'],
  32: ['process-mismatch', 'no-options', 'data-dir-mismatch'],
  40: ['started-failed'],
  41: ['started-failed'],
};

export interface TailInput {
  /** `app-v<major.minor.patch>`: the app's own release. */
  ref: string;
  telemetryVersion: number;
  credentialCommand: boolean;
  /** Only the check step. */
  check: boolean;
}

/** The argv tail, or `null` when a value is outside its shape (the caller refuses; nothing runs). */
export function buildTail(i: TailInput): string[] | null {
  const telemetry = String(i.telemetryVersion);
  if (!UPDATE_REF.test(i.ref) || !TELEMETRY_VERSION_ARG.test(telemetry)) return null;
  return ['--ref', i.ref, '--mac-telemetry-version', telemetry, '--mac-credential-command', i.credentialCommand ? 'yes' : 'no', '--progress', 'json', ...(i.check ? ['--check'] : [])];
}

/** `app-v<version>` of the app, or `null` when the version is not a plain release (a prerelease has no tag to install). */
export function refOf(appVersion: string): string | null {
  const ref = `app-v${appVersion}`;
  return UPDATE_REF.test(ref) ? ref : null;
}

export interface UpdateResultEvent {
  exit: number;
  reason: string | null;
  backup: string | null;
  oldCommit: string | null;
  newCommit: string | null;
}

export type ProgressEvent = { event: 'phase'; phase: UpdatePhase } | ({ event: 'result' } & UpdateResultEvent);

const PHASE_KEYS = ['v', 'event', 'phase'];
const RESULT_KEYS = ['v', 'event', 'exit', 'reason', 'backup', 'oldCommit', 'newCommit'];
const ALL_REASONS: readonly string[] = [...new Set(Object.values(UPDATE_REASONS).flat())];

function sameKeys(o: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => k in o);
}

/** One line as an event, or `null` when it is not JSON or not exactly the schema. Pure. */
export function parseProgressLine(line: string): ProgressEvent | null {
  if (line.length === 0 || line.length > MAX_UPDATE_OUTPUT_BYTES) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.v !== 1) return null;
  if (o.event === 'phase') {
    if (!sameKeys(o, PHASE_KEYS) || typeof o.phase !== 'string' || !(UPDATE_PHASES as readonly string[]).includes(o.phase)) return null;
    return { event: 'phase', phase: o.phase as UpdatePhase };
  }
  if (o.event === 'result') {
    if (!sameKeys(o, RESULT_KEYS)) return null;
    if (typeof o.exit !== 'number' || !Number.isInteger(o.exit) || o.exit < 0 || o.exit > 255) return null;
    if (o.reason !== null && (typeof o.reason !== 'string' || !ALL_REASONS.includes(o.reason))) return null;
    // eslint-disable-next-line no-control-regex
    if (o.backup !== null && (typeof o.backup !== 'string' || o.backup.length > MAX_BACKUP_LENGTH || !o.backup.startsWith('/') || /[\u0000-\u001f\u007f]/.test(o.backup))) return null;
    for (const k of ['oldCommit', 'newCommit'] as const) if (o[k] !== null && (typeof o[k] !== 'string' || !COMMIT.test(o[k] as string))) return null;
    return { event: 'result', exit: o.exit, reason: o.reason as string | null, backup: o.backup as string | null, oldCommit: o.oldCommit as string | null, newCommit: o.newCommit as string | null };
  }
  return null;
}

const PHASE_RANK: Record<UpdatePhase, number> = { check: 0, backup: 1, swap: 2, start: 3, verify: 4, rollback: 5 };

/** Whether `next` is not behind `current`: a phase only moves forward, so a stray line never makes a past phase current again. */
export function phaseAdvances(current: UpdatePhase | null, next: UpdatePhase): boolean {
  return current === null || PHASE_RANK[next] >= PHASE_RANK[current];
}

/** From `backup` on the script ignores signals and runs to the end alone (decision 0022 section 6). */
export function pastCheck(phase: UpdatePhase | null): boolean {
  return phase !== null && phase !== 'check';
}

export type ProgressSink = (event: ProgressEvent) => void;

/**
 * Feeds stdout chunks in, events out. At most `MAX_UPDATE_OUTPUT_BYTES` in all: past it `overflow` is true and the
 * rest is dropped (the caller decides whether the run is cut). A partial last line is read by `end()`.
 */
export class ProgressParser {
  private buffer = '';
  private readonly decoder = new StringDecoder('utf8');
  private total = 0;
  overflow = false;
  private readonly sink: ProgressSink;

  constructor(sink: ProgressSink) {
    this.sink = sink;
  }

  push(chunk: Buffer): void {
    if (this.overflow) return;
    // The bytes up to the cap are read, whole lines included; the first byte past it flags the overflow.
    const room = MAX_UPDATE_OUTPUT_BYTES - this.total;
    const take = chunk.length > room ? chunk.subarray(0, room) : chunk;
    this.total += take.length;
    this.buffer += this.decoder.write(take);
    let at: number;
    while ((at = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, at).replace(/\r$/, '');
      this.buffer = this.buffer.slice(at + 1);
      const event = parseProgressLine(line);
      if (event) this.sink(event);
    }
    if (take.length < chunk.length) {
      this.overflow = true;
      this.buffer = '';
    }
  }

  end(): void {
    if (this.overflow) return;
    const line = this.buffer.replace(/\r$/, '');
    this.buffer = '';
    const event = parseProgressLine(line);
    if (event) this.sink(event);
  }
}

export const UPDATE_STATES = ['idle', 'checking', 'ready', 'refused', 'running', 'succeeded', 'rolled-back', 'rollback-failed', 'failed', 'timed-out', 'canceled'] as const;
export type UpdateState = (typeof UPDATE_STATES)[number];

export interface RunFacts {
  /** The ssh exit code (the script's, passed through), 255 its own, `null` when a signal ended it or it never ran. */
  exitCode: number | null;
  /** From the closed reason list and only when it fits the exit code; else `null`. */
  reason: string | null;
  /** The last phase event read. */
  phase: UpdatePhase | null;
  /** The command could not start (ENOENT, EACCES). */
  spawnFailed?: boolean;
}

/**
 * The state of a FINISHED run and the key of the text the screen shows, from the exit code. The exit codes of the
 * script are 0, 2, 20 to 23, 30 to 33, 40, 41 and 130 (decision 0022 section 7); 255 is ssh's own. Pure.
 *
 * - 20 to 23, 30 to 33: `refused`, nothing was stopped (the script repeats the guard before it stops anything).
 * - 40: `rolled-back`; 41: `rollback-failed`; 130: `canceled`; 0: `succeeded`.
 * - 255 or a signal: before `backup` the SSH never reached the script ("nothing was changed"); from `backup` on contact
 *   was lost in the middle and the script runs on alone: `timed-out`.
 */
export function classify(f: RunFacts, kind: 'check' | 'update'): { state: UpdateState; key: string } {
  const code = f.exitCode;
  if (f.spawnFailed) return { state: 'failed', key: 'spawn-failed' };
  if (code === 0) return kind === 'check' ? { state: 'ready', key: 'check-ready' } : { state: 'succeeded', key: 'exit-0' };
  if (code === 130) return { state: 'canceled', key: 'canceled' };
  if (code === 40) return { state: 'rolled-back', key: 'exit-40' };
  if (code === 41) return { state: 'rollback-failed', key: 'exit-41' };
  if (code !== null && ((code >= 20 && code <= 23) || code === 31 || code === 33)) return { state: 'refused', key: `exit-${code}` };
  if (code === 30 || code === 32) return { state: 'refused', key: f.reason ? `exit-${code}-${f.reason}` : `exit-${code}` };
  if (code === 126 || code === 127) return { state: 'failed', key: 'node-not-found' };
  if (code === null || code === 255) {
    return pastCheck(f.phase) ? { state: 'timed-out', key: 'timeout-after-swap' } : { state: 'failed', key: 'ssh-unreachable' };
  }
  return { state: 'failed', key: 'unknown-exit' };
}

/** The reason only when the script's list allows it for that exit code (an event that does not fit is not trusted). */
export function reasonFits(exitCode: number | null, reason: string | null): string | null {
  if (reason === null || exitCode === null) return null;
  return UPDATE_REASONS[exitCode]?.includes(reason) ? reason : null;
}
