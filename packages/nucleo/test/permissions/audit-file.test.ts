// The audit file of the permission requests (#618, layer 3): permissions, the allow-list of fields, and the keyed hash of the reason.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { join } from 'node:path';
import { PERMISSION_AUDIT_FILE, PERMISSION_AUDIT_KEY_FILE, PermissionAuditFile } from '../../src/permissions/adapters/audit-file.ts';
import type { PermissionAuditRecord } from '../../src/permissions/ports.ts';
import { readJsonLines, tempDir } from './oltp-fixtures.ts';

const mode = (path: string): number => statSync(path).mode & 0o777;
const answered = (reason: string | null, requestId = 'rq-1'): PermissionAuditRecord => ({ at: 1, event: 'answered', requestId, sessionId: 'S1', digest: 'd1', state: 'answered', decision: 'deny', answeredBy: 'owner', channel: 'ui', reason });
const lines = (dataDir: string): Record<string, unknown>[] => readJsonLines(join(dataDir, PERMISSION_AUDIT_FILE));
const keyOf = (dataDir: string): Buffer => readFileSync(join(dataDir, PERMISSION_AUDIT_KEY_FILE));
const hmacOf = (dataDir: string, text: string): string => createHmac('sha256', keyOf(dataDir)).update(text).digest('hex');

describe('the file and its folder (#618/AC-7)', () => {
  test('#618/AC-7: the folder is created 0700 and the file 0600', () => {
    const dataDir = join(tempDir(), 'nested', 'data');
    new PermissionAuditFile(dataDir).append({ at: 1, event: 'registered', requestId: 'rq-1', sessionId: 'S1' });
    assert.equal(mode(dataDir), 0o700);
    assert.equal(mode(join(dataDir, PERMISSION_AUDIT_FILE)), 0o600);
  });

  test('a folder that existed more open is closed to 0700', () => {
    const dataDir = tempDir();
    chmodSync(dataDir, 0o755);
    new PermissionAuditFile(dataDir).append({ at: 1, event: 'registered', requestId: 'rq-1', sessionId: 'S1' });
    assert.equal(mode(dataDir), 0o700);
  });

  test('each record is one line, appended', () => {
    const dataDir = tempDir();
    const audit = new PermissionAuditFile(dataDir);
    audit.append({ at: 1, event: 'registered', requestId: 'rq-1', sessionId: 'S1' });
    audit.append({ at: 2, event: 'closed', requestId: 'rq-1', sessionId: 'S1', settledBy: 'expiry', state: 'expired' });
    assert.deepEqual(lines(dataDir).map((l) => l.event), ['registered', 'closed']);
  });

  test('a symlink at the audit path is not followed: the target is untouched and only the error code is logged', () => {
    const dataDir = tempDir();
    const target = join(tempDir(), 'victim.txt');
    writeFileSync(target, 'victim content', { mode: 0o644 });
    symlinkSync(target, join(dataDir, PERMISSION_AUDIT_FILE));
    const logged: string[] = [];
    assert.doesNotThrow(() => new PermissionAuditFile(dataDir, (m) => logged.push(m)).append(answered('top secret words')));
    assert.equal(readFileSync(target, 'utf8'), 'victim content');
    assert.equal(mode(target), 0o644);
    assert.equal(logged.length, 1);
    assert.match(logged[0]!, /permission audit: could not write \(\w+\)/);
    assert.doesNotMatch(logged[0]!, /victim|top secret words/);
  });

  test('an audit file that others can read is refused, not narrowed: nothing is written to it, and the code is logged', () => {
    const dataDir = tempDir();
    const file = join(dataDir, PERMISSION_AUDIT_FILE);
    writeFileSync(file, '');
    chmodSync(file, 0o644);
    const logged: string[] = [];
    new PermissionAuditFile(dataDir, (m) => logged.push(m)).append(answered('top secret words'));
    assert.equal(readFileSync(file, 'utf8'), '');
    assert.equal(logged.length, 1);
    assert.match(logged[0]!, /permission audit: could not write \(ERR_AUDIT_MODE\)/);
  });

  test('a write that fails is logged by its code and never thrown, and the log holds neither the reason nor the path', () => {
    const dataDir = join(tempDir(), 'a-file');
    writeFileSync(dataDir, 'not a folder');
    const logged: string[] = [];
    assert.doesNotThrow(() => new PermissionAuditFile(dataDir, (m) => logged.push(m)).append(answered('top secret words')));
    assert.equal(logged.length, 1);
    assert.match(logged[0]!, /permission audit: could not write \(\w+\)/);
    assert.doesNotMatch(logged[0]!, /top secret words|a-file/);
  });
});

describe('what a line holds (#618/AC-7)', () => {
  test('#618/AC-7: only the allow-listed fields are written, whatever else the record object carries', () => {
    const dataDir = tempDir();
    const record = Object.assign(answered('plain words hunter2pw'), {
      toolName: 'Bash', terminalOnly: false, settledBy: 'hook' as const, operation: 'wait', code: 'gone',
      toolInput: { command: 'rm -rf hunter2pw' }, summary: 'DATABASE_URL=*** npm run migrate', ownerToken: 'owner-token-value', windowCredential: 'window-credential-value', cwd: '/secret/cwd',
    });
    new PermissionAuditFile(dataDir).append(record);
    const text = readFileSync(join(dataDir, PERMISSION_AUDIT_FILE), 'utf8');
    assert.doesNotMatch(text, /hunter2pw|plain words|npm run migrate|owner-token-value|window-credential-value|secret\/cwd|toolInput|summary|ownerToken|windowCredential/);
    const [line] = lines(dataDir);
    assert.deepEqual(Object.keys(line!).sort(), ['answeredBy', 'at', 'channel', 'code', 'decision', 'digest', 'event', 'operation', 'reasonHmac', 'requestId', 'sessionId', 'settledBy', 'state', 'terminalOnly', 'toolName']);
  });

  test('a record with no reason field has no reasonHmac, and a null reason writes null', () => {
    const dataDir = tempDir();
    const audit = new PermissionAuditFile(dataDir);
    audit.append({ at: 1, event: 'delivered', requestId: 'rq-1', sessionId: 'S1', state: 'delivered' });
    audit.append(answered(null));
    const [delivered, none] = lines(dataDir);
    assert.equal('reasonHmac' in delivered!, false);
    assert.equal(none!.reasonHmac, null);
    assert.equal(statSync(join(dataDir, PERMISSION_AUDIT_KEY_FILE), { throwIfNoEntry: false }), undefined, 'no key is made until a reason needs one');
  });

  test('a refusal line carries the operation and the code, cut to a bounded size', () => {
    const dataDir = tempDir();
    new PermissionAuditFile(dataDir).append({ at: 1, event: 'refused', requestId: 'r'.repeat(500), sessionId: 'S1', operation: 'answer', code: 'terminal_only' });
    const [line] = lines(dataDir);
    assert.equal(line!.operation, 'answer');
    assert.equal(line!.code, 'terminal_only');
    assert.ok((line!.requestId as string).length <= 128);
  });
});

describe('the keyed hash of the reason (#618/AC-7)', () => {
  test('#618/AC-7: the reason goes as the HMAC-SHA-256 of a 32-byte key stored 0600, and the key and the reason are not in the audit', () => {
    const dataDir = tempDir();
    new PermissionAuditFile(dataDir).append(answered('plain words hunter2pw'));
    const keyFile = join(dataDir, PERMISSION_AUDIT_KEY_FILE);
    assert.equal(keyOf(dataDir).length, 32);
    assert.equal(mode(keyFile), 0o600);
    const [line] = lines(dataDir);
    assert.equal(line!.reasonHmac, hmacOf(dataDir, 'plain words hunter2pw'));
    const audit = readFileSync(join(dataDir, PERMISSION_AUDIT_FILE), 'utf8');
    assert.doesNotMatch(audit, /plain words|hunter2pw|sha256/i);
    assert.equal(audit.includes(keyOf(dataDir).toString('hex')), false);
    assert.equal(audit.includes(keyOf(dataDir).toString('base64')), false);
  });

  test('the key is made once and reused: another instance of the same folder gives the same HMAC for the same reason', () => {
    const dataDir = tempDir();
    new PermissionAuditFile(dataDir).append(answered('same words', 'rq-1'));
    const key = keyOf(dataDir);
    new PermissionAuditFile(dataDir).append(answered('same words', 'rq-2'));
    new PermissionAuditFile(dataDir).append(answered('other words', 'rq-3'));
    assert.deepEqual(keyOf(dataDir), key);
    const [one, two, three] = lines(dataDir);
    assert.equal(one!.reasonHmac, two!.reasonHmac);
    assert.notEqual(one!.reasonHmac, three!.reasonHmac);
  });

  test('another data folder has another key, so the same reason gives another HMAC', () => {
    const one = tempDir();
    const two = tempDir();
    new PermissionAuditFile(one).append(answered('same words'));
    new PermissionAuditFile(two).append(answered('same words'));
    assert.notDeepEqual(keyOf(one), keyOf(two));
    assert.notEqual(lines(one)[0]!.reasonHmac, lines(two)[0]!.reasonHmac);
  });

  test('two instances that start with no key end with the one key that was made first, never overwritten', () => {
    const dataDir = tempDir();
    const a = new PermissionAuditFile(dataDir);
    const b = new PermissionAuditFile(dataDir);
    a.append(answered('same words', 'rq-1'));
    const key = keyOf(dataDir);
    b.append(answered('same words', 'rq-2'));
    assert.deepEqual(keyOf(dataDir), key);
    assert.equal(lines(dataDir)[0]!.reasonHmac, lines(dataDir)[1]!.reasonHmac);
  });

  test('a key file that is already there is used as it is', () => {
    const dataDir = tempDir();
    const key = Buffer.alloc(32, 7);
    writeFileSync(join(dataDir, PERMISSION_AUDIT_KEY_FILE), key, { mode: 0o600 });
    new PermissionAuditFile(dataDir).append(answered('words'));
    assert.deepEqual(keyOf(dataDir), key);
    assert.equal(lines(dataDir)[0]!.reasonHmac, createHmac('sha256', key).update('words').digest('hex'));
  });

  test('a key file of the wrong size is left alone, logged without its content, and the line is written with no reasonHmac', () => {
    const dataDir = tempDir();
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, PERMISSION_AUDIT_KEY_FILE), 'short', { mode: 0o600 });
    const logged: string[] = [];
    new PermissionAuditFile(dataDir, (m) => logged.push(m)).append(answered('words'));
    assert.equal(keyOf(dataDir).toString(), 'short');
    assert.equal(logged.length, 1);
    assert.match(logged[0]!, /permission audit: the reason key is unusable/);
    assert.doesNotMatch(logged[0]!, /short|words/);
    const [line] = lines(dataDir);
    assert.equal('reasonHmac' in line!, false);
    assert.equal(line!.event, 'answered');
  });

  test('a key file that is a symlink is not followed: logged by code, and the line is written with no reasonHmac', () => {
    const dataDir = tempDir();
    const real = join(tempDir(), 'real.key');
    writeFileSync(real, Buffer.alloc(32, 9), { mode: 0o600 });
    symlinkSync(real, join(dataDir, PERMISSION_AUDIT_KEY_FILE));
    const logged: string[] = [];
    new PermissionAuditFile(dataDir, (m) => logged.push(m)).append(answered('words'));
    assert.equal(logged.length, 1);
    assert.match(logged[0]!, /permission audit: the reason key is unusable \(\w+\)/);
    assert.doesNotMatch(logged[0]!, /real\.key|words/);
    assert.equal('reasonHmac' in lines(dataDir)[0]!, false);
  });

  test('a key file that others can read is not used: ERR_KEY_MODE is logged and the line has no reasonHmac', () => {
    const dataDir = tempDir();
    const keyFile = join(dataDir, PERMISSION_AUDIT_KEY_FILE);
    writeFileSync(keyFile, Buffer.alloc(32, 7));
    chmodSync(keyFile, 0o644);
    const logged: string[] = [];
    new PermissionAuditFile(dataDir, (m) => logged.push(m)).append(answered('words'));
    assert.equal(logged.length, 1);
    assert.match(logged[0]!, /the reason key is unusable \(ERR_KEY_MODE\)/);
    assert.equal('reasonHmac' in lines(dataDir)[0]!, false);
    assert.equal(mode(keyFile), 0o644, 'the file is left as it was');
  });
});
