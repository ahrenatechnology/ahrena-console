// Sending a message from the console to a live Claude Code session (#61, first slice): the domain.
// Pure: no disk, no socket, no clock (times come in as milliseconds).
//
// The message goes through Claude Code's cross-session inbox: every live session (Claude Desktop,
// terminal, `-p`) announces itself in `$CLAUDE_CONFIG_DIR/sessions/<pid>.json` with a Unix socket.
// The socket answers nothing, so "delivered" is only said when the session shows a new turn that
// came from us after the send; without it in `CONFIRM_WINDOW_MS`, the message is "sent, unconfirmed"
// and is never resent (the receiver's `crossSessionInbound` policy may hold it silently).
//
// The text itself never enters this model: only its SHA-256, for the audit.

/** A message's life: `sending` until the session shows the turn, the window ends or delivery fails. */
export const MESSAGE_STATES = ['sending', 'delivered', 'sent_unconfirmed', 'not_delivered'] as const;
export type MessageState = (typeof MESSAGE_STATES)[number];

/** Why the box cannot send to this session at all. */
export const UNAVAILABLE_REASONS = ['no_live_process', 'ambiguous', 'other_machine', 'unsupported_platform'] as const;
export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number];

/** Why the socket did not take the line. */
export const DELIVERY_FAILURES = ['socket_gone', 'connection_refused', 'timeout', 'socket_error'] as const;
export type DeliveryFailure = (typeof DELIVERY_FAILURES)[number];

/** The reason of a `not_delivered` message: the session became unavailable, or the socket failed. */
export type NotDeliveredReason = UnavailableReason | DeliveryFailure;
/** The reason of a `sent_unconfirmed` message. */
export const UNCONFIRMED_REASON = 'no_new_turn';
export type MessageReason = NotDeliveredReason | typeof UNCONFIRMED_REASON;

/** A request refused before any message exists (`closing`: the core is shutting down). */
export const REFUSALS = ['invalid_text', 'in_flight', 'rate_limited', 'ui_only', 'closing'] as const;
export type Refusal = (typeof REFUSALS)[number];

/** The text limit, in UTF-8 bytes (decision 0003, #61). */
export const MAX_TEXT_BYTES = 16 * 1024;
/** How long a sent message waits for the session's new turn before it is `sent_unconfirmed`. */
export const CONFIRM_WINDOW_MS = 60_000;

/** One process that says it is the session, as read from `sessions/<pid>.json` and checked. */
export interface LiveProcess {
  pid: number;
  /** The absolute path of its inbox socket. Stays inside the core: never in an API answer. */
  socketPath: string;
  /** The configuration folder whose `sessions/` listed it (its transcripts live under it). */
  configDir: string;
  /** `ClaudeAccount.id` logged in to that folder (the profile's), or `null`. */
  accountId: string | null;
  /** `claude-desktop`, `cli`, `sdk-cli`…, as the file says; `null` when absent or odd. */
  entrypoint: string | null;
  /** Remote Control is on: the file has a `bridgeSessionId` (its value is never kept). */
  remoteControl: boolean;
}

export type Availability = { available: true; process: LiveProcess } | { available: false; reason: UnavailableReason; processes: number };

export interface AvailabilityFacts {
  /** `process.platform` of the core. */
  platform: string;
  /** The session runs on another machine (#243, #282): this core has nowhere to deliver. */
  otherMachine: boolean;
  /** The processes found for the session, already checked (pid alive, socket ours). */
  processes: readonly LiveProcess[];
}

/**
 * Where a message to the session may go: exactly one live process on this machine. More than one
 * is refused (it could reach the wrong one), none is refused, another machine is refused.
 */
export function resolveAvailability({ platform, otherMachine, processes }: AvailabilityFacts): Availability {
  if (platform === 'win32') return { available: false, reason: 'unsupported_platform', processes: 0 };
  if (otherMachine) return { available: false, reason: 'other_machine', processes: 0 };
  const byPid = new Map<number, LiveProcess>();
  for (const p of processes) if (!byPid.has(p.pid)) byPid.set(p.pid, p);
  if (byPid.size === 0) return { available: false, reason: 'no_live_process', processes: 0 };
  if (byPid.size > 1) return { available: false, reason: 'ambiguous', processes: byPid.size };
  return { available: true, process: [...byPid.values()][0] };
}

const utf8 = new TextEncoder();

/** The text a person typed: a string with something besides blanks, at most `MAX_TEXT_BYTES` of UTF-8. */
export function checkText(text: unknown): { ok: true; bytes: number } | { ok: false } {
  if (!isValidText(text)) return { ok: false };
  return { ok: true, bytes: utf8.encode(text).length };
}

/** `checkText` as a type guard. */
export function isValidText(text: unknown): text is string {
  if (typeof text !== 'string' || text.trim().length === 0) return false;
  // A string longer than the limit in UTF-16 units is longer in UTF-8 too: no need to encode it.
  return text.length <= MAX_TEXT_BYTES && utf8.encode(text).length <= MAX_TEXT_BYTES;
}

/** A transition the message's state does not allow: a bug in the caller, not a user error. */
export class MessageStateError extends Error {}

/** What the API shows of a message. No text, no socket, no pid. */
export interface MessageView {
  messageId: string;
  sessionId: string;
  state: MessageState;
  reason: MessageReason | null;
  createdAt: string;
  /** When the socket took the line; `null` before, and when it never did. */
  sentAt: string | null;
  /** When the session's turn with the message started (its transcript time); only `delivered`. */
  deliveredAt: string | null;
  /** When the message left `sending`. */
  settledAt: string | null;
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/** One message the console sends. Settles once: delivered, sent unconfirmed or not delivered. */
export class OutgoingMessage {
  readonly id: string;
  readonly sessionId: string;
  readonly textSha256: string;
  readonly createdAt: number;
  private _state: MessageState = 'sending';
  private _reason: MessageReason | null = null;
  private _sentAt: number | null = null;
  private _deliveredAt: number | null = null;
  private _settledAt: number | null = null;

  private constructor(id: string, sessionId: string, textSha256: string, createdAt: number) {
    this.id = id;
    this.sessionId = sessionId;
    this.textSha256 = textSha256;
    this.createdAt = createdAt;
  }

  static create({ id, sessionId, textSha256, createdAt }: { id: string; sessionId: string; textSha256: string; createdAt: number }): OutgoingMessage {
    return new OutgoingMessage(id, sessionId, textSha256, createdAt);
  }

  get state(): MessageState {
    return this._state;
  }

  get reason(): MessageReason | null {
    return this._reason;
  }

  get sentAt(): number | null {
    return this._sentAt;
  }

  get settled(): boolean {
    return this._state !== 'sending';
  }

  /** The socket took the line. Still `sending`: only the session's turn confirms. */
  sent(at: number): void {
    this.mustBeSending('sent');
    if (this._sentAt !== null) throw new MessageStateError('the message was already sent');
    this._sentAt = at;
  }

  /** The session showed the turn this message started, at `turnAt`. */
  delivered(turnAt: number): void {
    this.mustBeSending('delivered');
    if (this._sentAt === null) throw new MessageStateError('delivered before it was sent');
    if (turnAt < this._sentAt) throw new MessageStateError('a turn before the send does not confirm it');
    this.settle('delivered', null, turnAt);
    this._deliveredAt = turnAt;
  }

  /** The window passed with no turn: sent, but nobody can say it arrived. */
  unconfirmed(at: number): void {
    this.mustBeSending('unconfirmed');
    if (this._sentAt === null) throw new MessageStateError('unconfirmed before it was sent');
    if (at - this._sentAt < CONFIRM_WINDOW_MS) throw new MessageStateError('the confirmation window is still open');
    this.settle('sent_unconfirmed', UNCONFIRMED_REASON, at);
  }

  /** Nothing reached the session. */
  notDelivered(reason: NotDeliveredReason, at: number): void {
    this.mustBeSending('notDelivered');
    this.settle('not_delivered', reason, at);
  }

  view(): MessageView {
    return {
      messageId: this.id,
      sessionId: this.sessionId,
      state: this._state,
      reason: this._reason,
      createdAt: iso(this.createdAt)!,
      sentAt: iso(this._sentAt),
      deliveredAt: iso(this._deliveredAt),
      settledAt: iso(this._settledAt),
    };
  }

  private mustBeSending(what: string): void {
    if (this._state !== 'sending') throw new MessageStateError(`${what}: the message is already ${this._state}`);
  }

  private settle(state: MessageState, reason: MessageReason | null, at: number): void {
    this._state = state;
    this._reason = reason;
    this._settledAt = at;
  }
}

export interface BurstLimitOptions {
  /** Messages one session may get in the window. */
  perSession: number;
  /** Messages all sessions together may get in the window. */
  total: number;
  windowMs: number;
}

/** Defaults: a person types; a script would not stay under these. */
export const DEFAULT_BURST: BurstLimitOptions = { perSession: 5, total: 20, windowMs: 60_000 };

/** A sliding window over the sends: refusing past it is honest, with how long to wait. */
export class BurstLimit {
  private readonly opts: BurstLimitOptions;
  private sends: { sessionId: string; at: number }[] = [];

  constructor(opts: BurstLimitOptions = DEFAULT_BURST) {
    this.opts = opts;
  }

  check(sessionId: string, now: number): { ok: true } | { ok: false; retryAfterMs: number } {
    this.sends = this.sends.filter((s) => now - s.at < this.opts.windowMs);
    const mine = this.sends.filter((s) => s.sessionId === sessionId);
    const blocking = mine.length >= this.opts.perSession ? mine[mine.length - this.opts.perSession] : this.sends.length >= this.opts.total ? this.sends[this.sends.length - this.opts.total] : null;
    return blocking ? { ok: false, retryAfterMs: blocking.at + this.opts.windowMs - now } : { ok: true };
  }

  record(sessionId: string, at: number): void {
    this.sends.push({ sessionId, at });
  }
}
