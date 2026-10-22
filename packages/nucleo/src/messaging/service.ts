// The messaging use cases (#61): whether the console can send to a session, sending one message a
// person typed in the /ui, and reading what became of it. Depends only on the ports (ports.ts).
//
// - Never more than one message in flight per session: in flight is from the request until the
//   message settles (delivered, sent unconfirmed or not delivered). A second request gets
//   `in_flight`, with the id of the first.
// - A burst limit per session and for all sessions (`BurstLimit`): `rate_limited`, with the wait.
// - The confirmation runs in the background: the probe is opened before the send, so only a turn
//   after it counts; the window ends in `sent_unconfirmed`, and nothing is ever resent.
// - The text goes to the socket and nowhere else: not to the log, the audit, an error or the store.
//   The records here keep its SHA-256 only. Messages live in memory: a restart forgets them.
// - The audit has a line the moment the socket takes the text (`sent`), so text that reached a
//   session is in the audit even if the core dies in the window; a second line says how it settled.
//   `close()` writes `sent_unconfirmed` (reason `closing`) for every message still in its window.

import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import {
  BurstLimit,
  CONFIRM_WINDOW_MS,
  isValidText,
  OutgoingMessage,
  resolveAvailability,
  type BurstLimitOptions,
  type LiveProcess,
  type MessageView,
  type NotDeliveredReason,
  type Refusal,
  type UnavailableReason,
} from './model.ts';
import type { AuditEntry, Inbox, LiveSessions, MessagingAudit, TurnProbe, TurnWatch } from './ports.ts';

export interface MessagingOptions {
  live: LiveSessions;
  inbox: Inbox;
  turns: TurnWatch;
  audit: MessagingAudit;
  platform?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  newId?: () => string;
  /** How often the probe is polled while the window is open. Default 500 ms. */
  pollMs?: number;
  burst?: BurstLimitOptions;
  log?: (message: string) => void;
}

/** What the compose box needs to know about a session. */
export interface MessagingAvailability {
  available: boolean;
  reason: UnavailableReason | null;
  /** The live process's entrypoint (`claude-desktop`, `cli`…); `null` unless available. */
  entrypoint: string | null;
  /** Remote Control is on in the live process; `false` unless available. */
  remoteControl: boolean;
  /** The name of the configuration folder that listed the live process (`.claude`, `.claude-team`), never its path; `null` unless available. */
  configDir: string | null;
  /** `ClaudeAccount.id` logged in to that folder; `null` when unknown or not available. */
  accountId: string | null;
  /** How many processes say they are the session (2 or more with `ambiguous`). */
  processes: number;
  /** The id of the message still in flight to this session, if any. */
  inFlight: string | null;
}

export type SendResult = { kind: 'accepted'; message: MessageView } | { kind: 'refused'; refusal: Refusal; retryAfterMs?: number; messageId?: string };

/** Settled messages are kept this long, for the /ui to read their outcome. */
const KEEP_MS = 60 * 60_000;
const MAX_KEPT = 500;

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

export class Messaging {
  private readonly live: LiveSessions;
  private readonly inbox: Inbox;
  private readonly turns: TurnWatch;
  private readonly audit: MessagingAudit;
  private readonly platform: string;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly newId: () => string;
  private readonly pollMs: number;
  private readonly burst: BurstLimit;
  private readonly log: (message: string) => void;
  private readonly messages = new Map<string, OutgoingMessage>();
  /** sessionId → id of the message in flight. */
  private readonly inFlight = new Map<string, string>();
  private closed = false;
  /** Messages whose `closing` line is already in the audit. */
  private readonly closedOut = new Set<string>();

  constructor(opts: MessagingOptions) {
    this.live = opts.live;
    this.inbox = opts.inbox;
    this.turns = opts.turns;
    this.audit = opts.audit;
    this.platform = opts.platform ?? process.platform;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms).unref()));
    this.newId = opts.newId ?? randomUUID;
    this.pollMs = opts.pollMs ?? 500;
    this.burst = new BurstLimit(opts.burst);
    this.log = opts.log ?? (() => {});
  }

  async availability(sessionId: string, { otherMachine = false }: { otherMachine?: boolean } = {}): Promise<MessagingAvailability> {
    const processes = otherMachine || this.platform === 'win32' ? [] : await this.live.find(sessionId).catch((e: unknown) => (this.log(`session ${sessionId}: cannot list the live processes (${(e as Error)?.name ?? 'error'})`), [] as LiveProcess[]));
    const a = resolveAvailability({ platform: this.platform, otherMachine, processes });
    const inFlight = this.inFlight.get(sessionId) ?? null;
    if (a.available) {
      const p = a.process;
      return { available: true, reason: null, entrypoint: p.entrypoint, remoteControl: p.remoteControl, configDir: basename(p.configDir), accountId: p.accountId, processes: 1, inFlight };
    }
    return { available: false, reason: a.reason, entrypoint: null, remoteControl: false, configDir: null, accountId: null, processes: a.processes, inFlight };
  }

  /** Sends what a person typed to the session's one live process on this machine. */
  async send(sessionId: string, text: unknown): Promise<SendResult> {
    const hash = typeof text === 'string' ? sha256(text) : null;
    if (!isValidText(text)) return this.refuse(sessionId, 'invalid_text', hash);
    const textSha256 = sha256(text);
    if (this.closed) return this.refuse(sessionId, 'closing', textSha256);
    const busy = this.inFlight.get(sessionId);
    if (busy) return { ...this.refuse(sessionId, 'in_flight', textSha256), messageId: busy };
    const now = this.now();
    const limit = this.burst.check(sessionId, now);
    if (!limit.ok) return { ...this.refuse(sessionId, 'rate_limited', textSha256), retryAfterMs: limit.retryAfterMs };
    this.burst.record(sessionId, now);
    this.prune(now);

    const message = OutgoingMessage.create({ id: this.newId(), sessionId, textSha256, createdAt: now });
    this.messages.set(message.id, message);
    this.inFlight.set(sessionId, message.id);
    try {
      const processes = await this.findProcesses(message);
      const a = resolveAvailability({ platform: this.platform, otherMachine: false, processes });
      if (!a.available) return this.accepted(this.fail(message, a.reason));
      // Opened before the write: only a turn after this point can confirm the message.
      const probe = await this.turns.open(a.process, sessionId, textSha256).catch((e: unknown) => {
        this.log(`message ${message.id}: cannot watch session ${sessionId} for the new turn (${(e as Error).message})`);
        return null;
      });
      const startedAt = this.now();
      const r = await this.inbox.deliver(a.process.socketPath, text);
      if (!r.ok) {
        probe?.close();
        return this.accepted(this.fail(message, r.reason));
      }
      message.sent(startedAt);
      this.record({ at: new Date(startedAt).toISOString(), sessionId, messageId: message.id, mechanism: 'inbox', outcome: 'sent', reason: null, textSha256 });
      this.log(`message ${message.id} to session ${sessionId}: written to the inbox of pid ${a.process.pid}`);
      this.confirm(message, probe).catch((e: unknown) => {
        this.log(`message ${message.id}: confirmation stopped (${(e as Error)?.name ?? 'error'})`);
        this.release(message);
      });
      return this.accepted(message);
    } catch (e) {
      // A port that broke its promise not to reject: the message did not go.
      this.log(`message ${message.id} to session ${sessionId}: ${(e as Error)?.name ?? 'error'}`);
      if (!message.settled) this.fail(message, 'socket_error');
      return this.accepted(message);
    } finally {
      // Whatever happened, a settled message never keeps the session busy.
      if (message.settled) this.release(message);
    }
  }

  /** The processes of the session; a failure to list them is "no live process" (logged), never thrown. */
  private async findProcesses(message: OutgoingMessage): Promise<LiveProcess[]> {
    if (this.platform === 'win32') return [];
    try {
      return await this.live.find(message.sessionId);
    } catch (e) {
      this.log(`message ${message.id}: cannot list the live processes (${(e as Error)?.name ?? 'error'})`);
      return [];
    }
  }

  /** The message, read through its own session; `null` when unknown here (or forgotten after a restart). */
  message(sessionId: string, messageId: string): MessageView | null {
    const m = this.messages.get(messageId);
    return m && m.sessionId === sessionId ? m.view() : null;
  }

  /**
   * Stops the background confirmations (the core is shutting down). Every message the socket took
   * whose window is still open gets its audit line now, `sent_unconfirmed` with reason `closing`,
   * instead of being dropped; a message still on its way to the socket gets it when the write returns.
   */
  close(): void {
    this.closed = true;
    for (const m of this.messages.values()) if (!m.settled && m.sentAt !== null) this.closeOut(m);
  }

  /** The audit line of a message the core closed on in its window. Once per message. */
  private closeOut(message: OutgoingMessage): void {
    if (this.closedOut.has(message.id)) return;
    this.closedOut.add(message.id);
    this.release(message);
    this.record({ at: new Date(this.now()).toISOString(), sessionId: message.sessionId, messageId: message.id, mechanism: 'inbox', outcome: 'sent_unconfirmed', reason: 'closing', textSha256: message.textSha256 });
    this.log(`message ${message.id} to session ${message.sessionId}: sent_unconfirmed (closing)`);
  }

  /** An audit line that never throws: a broken audit must not change what the message did. */
  private record(entry: AuditEntry): void {
    try {
      this.audit.record(entry);
    } catch (e) {
      this.log(`messaging audit: could not record (${(e as Error)?.name ?? 'error'})`);
    }
  }

  private async confirm(message: OutgoingMessage, probe: TurnProbe | null): Promise<void> {
    const sentAt = message.sentAt!;
    try {
      while (!this.closed && this.now() - sentAt < CONFIRM_WINDOW_MS) {
        const turnAt = probe ? await probe.poll().catch(() => null) : null;
        if (turnAt !== null) {
          // The transcript's clock and ours are the same machine's, but its line may carry a time
          // a few ms before the write call returned: never before the send.
          message.delivered(Math.max(turnAt, sentAt));
          return this.settle(message, 'delivered');
        }
        await this.sleep(this.pollMs);
      }
      if (this.closed) return this.closeOut(message);
      message.unconfirmed(Math.max(this.now(), sentAt + CONFIRM_WINDOW_MS));
      this.settle(message, 'sent_unconfirmed');
    } finally {
      probe?.close();
    }
  }

  private fail(message: OutgoingMessage, reason: NotDeliveredReason): OutgoingMessage {
    message.notDelivered(reason, this.now());
    this.settle(message, 'not_delivered');
    return message;
  }

  /** Frees the session for the next message. Idempotent. */
  private release(message: OutgoingMessage): void {
    if (this.inFlight.get(message.sessionId) === message.id) this.inFlight.delete(message.sessionId);
  }

  private settle(message: OutgoingMessage, outcome: 'delivered' | 'sent_unconfirmed' | 'not_delivered'): void {
    const view = message.view();
    this.release(message);
    this.audit.record({
      at: view.settledAt!,
      sessionId: message.sessionId,
      messageId: message.id,
      mechanism: 'inbox',
      outcome,
      reason: message.reason,
      textSha256: message.textSha256,
    });
    this.log(`message ${message.id} to session ${message.sessionId}: ${view.state}${view.reason ? ` (${view.reason})` : ''}`);
  }

  private refuse(sessionId: string, refusal: Refusal, textSha256: string | null): { kind: 'refused'; refusal: Refusal } {
    this.audit.record({ at: new Date(this.now()).toISOString(), sessionId, messageId: null, mechanism: 'inbox', outcome: 'refused', reason: refusal, textSha256 });
    this.log(`message to session ${sessionId}: refused (${refusal})`);
    return { kind: 'refused', refusal };
  }

  private accepted(message: OutgoingMessage): SendResult {
    return { kind: 'accepted', message: message.view() };
  }

  /** Forgets settled messages past `KEEP_MS`, and the oldest settled ones past `MAX_KEPT`. */
  private prune(now: number): void {
    for (const [id, m] of this.messages) if (m.settled && now - m.createdAt > KEEP_MS) this.messages.delete(id);
    if (this.messages.size < MAX_KEPT) return;
    for (const [id, m] of this.messages) {
      if (this.messages.size < MAX_KEPT) break;
      if (m.settled) this.messages.delete(id);
    }
  }
}
