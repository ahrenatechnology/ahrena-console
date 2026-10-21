// `MessagingAudit` as a JSON Lines file in the core's data folder (#61, decision 0007's audit):
// `<dataDir>/messaging-audit.jsonl`, `0600`, folder `0700`. One line per message, or per refused
// request: time, session, message id, mechanism (`inbox`), outcome, reason and the text's SHA-256.
// The text itself is never given to this adapter. A write that fails is logged, never thrown: the
// audit must not change whether a message goes.

import { appendFileSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AuditEntry, MessagingAudit } from '../ports.ts';

export const MESSAGING_AUDIT_FILE = 'messaging-audit.jsonl';

export function messagingAuditFile(dataDir: string): string {
  return join(dataDir, MESSAGING_AUDIT_FILE);
}

export class AuditFile implements MessagingAudit {
  private readonly file: string;
  private readonly log: (message: string) => void;

  constructor(file: string, log: (message: string) => void = () => {}) {
    this.file = file;
    this.log = log;
  }

  record(entry: AuditEntry): void {
    const line = JSON.stringify({
      at: entry.at,
      sessionId: entry.sessionId,
      messageId: entry.messageId,
      mechanism: entry.mechanism,
      outcome: entry.outcome,
      reason: entry.reason,
      textSha256: entry.textSha256,
    });
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      appendFileSync(this.file, `${line}\n`, { mode: 0o600 });
      chmodSync(this.file, 0o600);
    } catch (e) {
      this.log(`messaging audit: could not write (${(e as NodeJS.ErrnoException).code ?? 'error'})`);
    }
  }
}
