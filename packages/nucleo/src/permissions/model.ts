// A permission request from a Claude Code session, answered from the Console (decision 0025, #618): the domain.
// Pure: no disk, no socket, no clock (times come in as milliseconds, ids come in from the caller). (#618)
//
// The hook of the plugin registers one request per call that needs a permission. The request is `pending` until the (#618)
// window of the `/ui` answers it (`answered`), then it is handed once to the hook process that waits for it (#618)
// (`delivered`). Anything else that ends it first is a closing that is never delivered: the deadline (`expired`), the (#618)
// hook giving up (`withdrawn`), the card or the terminal answering first (`answered_elsewhere`), or the core starting (#618)
// again (`core_restarted`). An answered request that was not yet delivered can still be closed by any of them. (#618)
//
// What the request keeps of the call is its digest and a summary already masked. The raw tool input is never kept. (#618)
import { digestOf } from './digest.ts';
import { PermissionRefusal, REFUSAL_CODES, type RefusalCode } from './refusal.ts';
export { PermissionRefusal, REFUSAL_CODES, type RefusalCode };
import { summarizeCall } from './summary.ts';
import { isTerminalOnly } from './terminal-only.ts';

/** The life of a request. `delivered` means handed to the hook process, not applied by the session. */
export const REQUEST_STATES = ['pending', 'answered', 'delivered', 'expired', 'withdrawn', 'answered_elsewhere', 'core_restarted'] as const;
export type RequestState = (typeof REQUEST_STATES)[number];

/** What the person decides. Never a rule, never a mode: one call, once. */
export const DECISIONS = ['allow', 'deny'] as const;
export type Decision = (typeof DECISIONS)[number];

/** Where an answer came from. Only the window of the `/ui` answers. */
export const CHANNELS = ['ui'] as const;
export type Channel = (typeof CHANNELS)[number];

/** What closed a request: the clock, the hook, an event of the session, the core starting again. */
export const SETTLERS = ['expiry', 'hook', 'session_event', 'core_restart'] as const;
export type Settler = (typeof SETTLERS)[number];

/** How long a request waits for an answer: below the 10 minutes of the hook entry, which has its own 9 min 30 s deadline. */
export const EXPIRY_MS = 9 * 60_000 + 30_000;
/** The reason of a `deny`, in characters. */
export const MAX_REASON_CHARS = 500;

const GONE_STATES: readonly RequestState[] = ['expired', 'withdrawn', 'answered_elsewhere', 'core_restarted'];
const LINE_BREAK = /[\r\n\u0085\u2028\u2029]/;

export interface AnswerInput {
  decision: Decision;
  /** Only with a `deny`: one line, at most `MAX_REASON_CHARS` characters. Blank reads as none. (#618) */
  reason?: string;
  answeredBy: string;
  channel: Channel;
  now: number;
}

/** One permission request. Settles once: delivered, or closed without a delivery. */
export class PermissionRequest {
  readonly id: string;
  readonly sessionId: string;
  readonly toolName: string;
  readonly digest: string;
  /** The text the person reads, with the secrets already masked. (#618) */
  readonly summary: string;
  /** The summary was cut, so the screen marks it as such. (#618) */
  readonly summaryTruncated: boolean;
  readonly cwd: string;
  readonly permissionMode: string | null;
  /** Only the person at the terminal allows this call; the Console can only deny it. (#618) */
  readonly terminalOnly: boolean;
  readonly createdAt: number;
  readonly expiresAt: number;
  private _state: RequestState = 'pending';
  private _decision: Decision | null = null;
  private _reason: string | null = null;
  private _answeredBy: string | null = null;
  private _channel: Channel | null = null;
  private _settledAt: number | null = null;
  private _settledBy: Settler | null = null;

  private constructor(p: Pick<PermissionRequest, 'id' | 'sessionId' | 'toolName' | 'digest' | 'summary' | 'summaryTruncated' | 'cwd' | 'permissionMode' | 'terminalOnly' | 'createdAt' | 'expiresAt'>) {
    this.id = p.id;
    this.sessionId = p.sessionId;
    this.toolName = p.toolName;
    this.digest = p.digest;
    this.summary = p.summary;
    this.summaryTruncated = p.summaryTruncated;
    this.cwd = p.cwd;
    this.permissionMode = p.permissionMode;
    this.terminalOnly = p.terminalOnly;
    this.createdAt = p.createdAt;
    this.expiresAt = p.expiresAt;
  }

  /** Opens a request from a hook payload. The tool input is read for the digest, the summary and the policy, and dropped. (#618) */
  static async open(p: { id: string; sessionId: string; toolName: string; toolInput: unknown; cwd: string; permissionMode: string | null; now: number }): Promise<PermissionRequest> {
    const { summary, truncated } = summarizeCall(p.toolName, p.toolInput);
    return new PermissionRequest({
      id: p.id,
      sessionId: p.sessionId,
      toolName: p.toolName,
      digest: await digestOf({ sessionId: p.sessionId, toolName: p.toolName, toolInput: p.toolInput, cwd: p.cwd }),
      summary,
      summaryTruncated: truncated,
      cwd: p.cwd,
      permissionMode: p.permissionMode,
      terminalOnly: isTerminalOnly(p.toolName, p.toolInput),
      createdAt: p.now,
      expiresAt: p.now + EXPIRY_MS,
    });
  }

  get state(): RequestState {
    return this._state;
  }
  get decision(): Decision | null {
    return this._decision;
  }
  get reason(): string | null {
    return this._reason;
  }
  get answeredBy(): string | null {
    return this._answeredBy;
  }
  get channel(): Channel | null {
    return this._channel;
  }
  get settledAt(): number | null {
    return this._settledAt;
  }
  get settledBy(): Settler | null {
    return this._settledBy;
  }

  /** It can still change: pending, or answered and not yet delivered. (#618) */
  get isOpen(): boolean {
    return this._state === 'pending' || this._state === 'answered';
  }

  /** The person's answer, only while pending and before the deadline. A refusal changes nothing. (#618) */
  answer({ decision, reason, answeredBy, channel, now }: AnswerInput): void {
    if (this._state === 'answered' || this._state === 'delivered') throw new PermissionRefusal('already_answered');
    if (this._state !== 'pending' || now >= this.expiresAt) throw new PermissionRefusal('gone');
    if (!(DECISIONS as readonly string[]).includes(decision)) throw new PermissionRefusal('invalid_decision');
    if (answeredBy.trim() === '' || !(CHANNELS as readonly string[]).includes(channel)) throw new PermissionRefusal('invalid_answer');
    if (decision === 'allow' && this.terminalOnly) throw new PermissionRefusal('terminal_only');
    const kept = decision === 'deny' ? checkReason(reason) : rejectReason(reason);
    this._state = 'answered';
    this._decision = decision;
    this._reason = kept;
    this._answeredBy = answeredBy;
    this._channel = channel;
  }

  /** The hook process takes the answer. Once: a second delivery is refused. (#618) */
  deliver(now: number): void {
    if (this._state === 'delivered') throw new PermissionRefusal('already_delivered');
    if (this._state === 'pending' && now < this.expiresAt) throw new PermissionRefusal('not_answered');
    if (this._state !== 'answered' || now >= this.expiresAt) throw new PermissionRefusal('gone');
    this.settle('delivered', 'hook', now);
  }

  /** The deadline passed with no delivery. Due only at or after `expiresAt`. (#618) */
  expire(now: number): void {
    this.mustBeOpen();
    if (now < this.expiresAt) throw new PermissionRefusal('not_due');
    this.settle('expired', 'expiry', now);
  }

  /** The hook gave up at its own deadline. (#618) */
  withdraw(now: number): void {
    this.mustBeOpen();
    this.settle('withdrawn', 'hook', now);
  }

  /** The card or the terminal answered first, or the session moved on: an answered request that was not delivered closes too. (#618) */
  closeElsewhere(now: number): void {
    this.mustBeOpen();
    this.settle('answered_elsewhere', 'session_event', now);
  }

  /** The core started again: nothing answered before is delivered after it. (#618) */
  closeAfterRestart(now: number): void {
    this.mustBeOpen();
    this.settle('core_restarted', 'core_restart', now);
  }

  private mustBeOpen(): void {
    if (this._state === 'delivered') throw new PermissionRefusal('already_delivered');
    if (GONE_STATES.includes(this._state)) throw new PermissionRefusal('gone');
  }

  private settle(state: RequestState, by: Settler, at: number): void {
    this._state = state;
    this._settledBy = by;
    this._settledAt = at;
  }
}

/** A `deny` reason: none, or one line of at most `MAX_REASON_CHARS` characters. (#618) */
function checkReason(reason: string | undefined): string | null {
  if (reason === undefined) return null;
  if (typeof reason !== 'string' || LINE_BREAK.test(reason) || [...reason].length > MAX_REASON_CHARS) throw new PermissionRefusal('invalid_reason');
  const trimmed = reason.trim();
  return trimmed === '' ? null : trimmed;
}

/** An `allow` carries no reason: there is nothing to say about a call that goes ahead. (#618) */
function rejectReason(reason: string | undefined): null {
  if (reason !== undefined && reason.trim() !== '') throw new PermissionRefusal('invalid_reason');
  return null;
}
