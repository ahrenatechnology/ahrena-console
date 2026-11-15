// `PermissionAudit` as a JSON Lines file in the core's data folder (decision 0025, "Auditoria", #618/AC-7):
// `<dataDir>/permission-audit.jsonl`, `0600`, folder `0700`, in the mould of `messaging/adapters/audit-file.ts`. (#618)
// A line holds an allow-list of fields and nothing else: never the tool input, the summary, the owner token or the window (#618)
// credential, whatever the record object carries. The reason of a deny reaches this adapter in memory only and leaves it as (#618)
// `reasonHmac`, an HMAC-SHA-256 under a random 32-byte key of this data folder (`permission-audit.key`, `0600`, made once on (#618)
// first use, never logged, never written to the audit). Without a key the line is written with no `reasonHmac` at all (#618)
// (`null` means "there was no reason"). A write that fails is logged by its error code, never thrown. (#618)
import { createHmac, randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PermissionAudit, PermissionAuditRecord } from '../ports.ts';

export const PERMISSION_AUDIT_FILE = 'permission-audit.jsonl';
export const PERMISSION_AUDIT_KEY_FILE = 'permission-audit.key';
const KEY_BYTES = 32;
const MAX_FIELD_CHARS = 128;

/** A text field of the record, cut: ids and names come from callers, so they are data. (#618) */
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value.slice(0, MAX_FIELD_CHARS) : undefined);

const codeOf = (error: unknown): string => (error as NodeJS.ErrnoException).code ?? 'error';

export class PermissionAuditFile implements PermissionAudit {
  private readonly dataDir: string;
  private readonly log: (message: string) => void;
  private key: Buffer | null = null;

  constructor(dataDir: string, log: (message: string) => void = () => {}) {
    this.dataDir = dataDir;
    this.log = log;
  }

  append(record: PermissionAuditRecord): void {
    try {
      mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
      const file = join(this.dataDir, PERMISSION_AUDIT_FILE);
      appendFileSync(file, `${JSON.stringify(this.lineOf(record))}\n`, { mode: 0o600 });
      chmodSync(file, 0o600);
    } catch (e) {
      this.log(`permission audit: could not write (${codeOf(e)})`);
    }
  }

  /** The allow-list: each field is named here, and a field not named never reaches the file. (#618) */
  private lineOf(record: PermissionAuditRecord): Record<string, unknown> {
    return {
      at: typeof record.at === 'number' ? record.at : undefined,
      event: text(record.event),
      requestId: text(record.requestId),
      sessionId: text(record.sessionId),
      toolName: text(record.toolName),
      digest: text(record.digest),
      terminalOnly: typeof record.terminalOnly === 'boolean' ? record.terminalOnly : undefined,
      state: text(record.state),
      decision: text(record.decision),
      answeredBy: text(record.answeredBy),
      channel: text(record.channel),
      reasonHmac: this.reasonHmac(record.reason),
      settledBy: text(record.settledBy),
      operation: text(record.operation),
      code: text(record.code),
    };
  }

  /** `undefined` when the record has no reason field (or no key), `null` for a deny with no reason, else the keyed hash. (#618) */
  private reasonHmac(reason: string | null | undefined): string | null | undefined {
    if (reason === undefined) return undefined;
    if (reason === null) return null;
    try {
      return createHmac('sha256', this.keyOfFolder()).update(reason).digest('hex');
    } catch (e) {
      this.log(`permission audit: the reason key is unusable (${codeOf(e)})`);
      return undefined;
    }
  }

  private keyOfFolder(): Buffer {
    if (this.key !== null) return this.key;
    const path = join(this.dataDir, PERMISSION_AUDIT_KEY_FILE);
    let key = readKeyIfThere(path);
    if (key === null) {
      createKeyOnce(path);
      key = readKeyIfThere(path);
    }
    if (key === null) throw Object.assign(new Error('key missing'), { code: 'ENOENT' });
    this.key = key;
    return key;
  }
}

function readKeyIfThere(path: string): Buffer | null {
  let key: Buffer;
  try {
    key = readFileSync(path);
  } catch (e) {
    if (codeOf(e) === 'ENOENT') return null;
    throw e;
  }
  if (key.length !== KEY_BYTES) throw Object.assign(new Error('key size'), { code: 'ERR_KEY_SIZE' });
  return key;
}

/**
 * Makes the key file with its whole content or not at all, and never over another one: the bytes are written to a private (#618)
 * temporary file (`wx`, `0600`) and hard-linked to the final name, which fails when another starter got there first.
 */
function createKeyOnce(path: string): void {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temporary, randomBytes(KEY_BYTES), { flag: 'wx', mode: 0o600 });
  try {
    linkSync(temporary, path);
  } catch (e) {
    if (codeOf(e) !== 'EEXIST') throw e;
  } finally {
    unlinkSync(temporary);
  }
}
