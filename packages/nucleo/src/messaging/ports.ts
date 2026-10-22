// The messaging ports (#61). The use cases (service.ts) depend only on these; the adapters live in
// adapters/ and the tests stand doubles in for them:
//
// - `LiveSessions`: the processes that say they are a session, read from each configuration
//   folder's `sessions/<pid>.json` and checked (adapters/sessions-dir.ts). Never opens a `.key`.
// - `Inbox`: writes one line to a session's inbox socket (adapters/socket-inbox.ts).
// - `TurnWatch`: watches the session for the turn our message starts (adapters/transcript-turns.ts).
// - `MessagingAudit`: one line per message, with the text's SHA-256 and never the text
//   (adapters/audit-file.ts).

import type { DeliveryFailure, LiveProcess, MessageReason, MessageState, Refusal } from './model.ts';

export interface LiveSessions {
  /** The checked live processes whose `sessionId` is this one, across all configuration folders. */
  find(sessionId: string): Promise<LiveProcess[]>;
}

export type DeliveryResult = { ok: true } | { ok: false; reason: DeliveryFailure };

export interface Inbox {
  /** Writes the text as one user message to the socket. Never rejects: a failure is a result. */
  deliver(socketPath: string, text: string): Promise<DeliveryResult>;
}

/** Watches one session for the turn our message starts. Opened before the send, so it sees only what comes after. */
export interface TurnProbe {
  /** The time (ms) of the session's turn with this message, from this core, if it showed up since the last call; otherwise `null`. */
  poll(): Promise<number | null>;
  close(): void;
}

export interface TurnWatch {
  /** Watches for the turn of the message whose text hashes to `textSha256` (hex SHA-256). */
  open(process: LiveProcess, sessionId: string, textSha256: string): Promise<TurnProbe>;
}

export interface AuditEntry {
  /**
   * ISO time of the event: the socket took the line (`sent`), the message settled, the core closed
   * with it in flight (`sent_unconfirmed`, reason `closing`), or the request was refused.
   */
  at: string;
  sessionId: string;
  messageId: string | null;
  mechanism: 'inbox';
  /** `sent`: the socket took the line; a second line follows when the message settles or the core closes. */
  outcome: Exclude<MessageState, 'sending'> | 'sent' | 'refused';
  reason: MessageReason | Refusal | null;
  /** SHA-256 of the text, hex; `null` when the request had no text string. */
  textSha256: string | null;
}

export interface MessagingAudit {
  record(entry: AuditEntry): void;
}
