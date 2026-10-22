// The messaging domain (#61): which live process a message may go to, what text is acceptable, the
// life of one outgoing message and the burst limit. Pure: no disk, no socket, no clock.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  BurstLimit,
  checkText,
  CONFIRM_WINDOW_MS,
  MAX_TEXT_BYTES,
  MessageStateError,
  OutgoingMessage,
  resolveAvailability,
  type LiveProcess,
} from '../../src/messaging/model.ts';

const proc = (pid: number, extra: Partial<LiveProcess> = {}): LiveProcess => ({
  pid,
  socketPath: `/tmp/fake/${pid}.sock`,
  configDir: '/tmp/fake-config',
  accountId: null,
  entrypoint: 'claude-desktop',
  remoteControl: false,
  ...extra,
});

describe('resolveAvailability (#61/AC-1)', () => {
  test('exactly one live process is available, with its entrypoint and Remote Control', () => {
    const r = resolveAvailability({ platform: 'darwin', otherMachine: false, processes: [proc(10, { remoteControl: true })] });
    assert.equal(r.available, true);
    assert.equal(r.available && r.process.pid, 10);
    assert.equal(r.available && r.process.remoteControl, true);
  });

  test('none is no_live_process', () => {
    assert.deepEqual(resolveAvailability({ platform: 'darwin', otherMachine: false, processes: [] }), { available: false, reason: 'no_live_process', processes: 0 });
  });

  test('two processes claiming the session are ambiguous, the same pid seen twice is one', () => {
    assert.deepEqual(resolveAvailability({ platform: 'linux', otherMachine: false, processes: [proc(10), proc(11)] }), { available: false, reason: 'ambiguous', processes: 2 });
    const same = resolveAvailability({ platform: 'linux', otherMachine: false, processes: [proc(10), proc(10, { configDir: '/tmp/other' })] });
    assert.equal(same.available, true);
  });

  test('a session of another machine is other_machine, whatever is found here', () => {
    assert.deepEqual(resolveAvailability({ platform: 'darwin', otherMachine: true, processes: [proc(10)] }), { available: false, reason: 'other_machine', processes: 0 });
  });

  test('Windows is unsupported_platform: the inbox there needs the token, which the core never reads', () => {
    assert.deepEqual(resolveAvailability({ platform: 'win32', otherMachine: false, processes: [proc(10)] }), { available: false, reason: 'unsupported_platform', processes: 0 });
  });
});

describe('checkText', () => {
  test('a non-empty string up to 16 KiB of UTF-8', () => {
    assert.deepEqual(checkText('oi'), { ok: true, bytes: 2 });
    assert.equal(checkText('é'.repeat(MAX_TEXT_BYTES / 2)).ok, true);
    assert.equal(checkText('a'.repeat(MAX_TEXT_BYTES)).ok, true);
  });

  test('refuses empty, blank, too long and non-strings', () => {
    for (const bad of ['', '   \n\t', 'a'.repeat(MAX_TEXT_BYTES + 1), 'é'.repeat(MAX_TEXT_BYTES / 2 + 1), null, undefined, 42, ['oi'], { text: 'oi' }]) {
      assert.equal(checkText(bad).ok, false, JSON.stringify(bad)?.slice(0, 40));
    }
  });
});

describe('OutgoingMessage', () => {
  const t0 = Date.parse('2026-10-21T10:00:00.000Z');
  const make = () => OutgoingMessage.create({ id: 'm1', sessionId: 's1', textSha256: 'ab'.repeat(32), createdAt: t0 });

  test('starts sending, is delivered by a turn after it was sent', () => {
    const m = make();
    assert.equal(m.state, 'sending');
    m.sent(t0 + 10);
    m.delivered(t0 + 900);
    assert.deepEqual(m.view(), {
      messageId: 'm1',
      sessionId: 's1',
      state: 'delivered',
      reason: null,
      createdAt: '2026-10-21T10:00:00.000Z',
      sentAt: '2026-10-21T10:00:00.010Z',
      deliveredAt: '2026-10-21T10:00:00.900Z',
      settledAt: '2026-10-21T10:00:00.900Z',
    });
  });

  test('the view never carries the text, only its hash stays in the record', () => {
    const m = make();
    assert.equal(JSON.stringify(m.view()).includes('ab'.repeat(32)), false);
    assert.equal(m.textSha256, 'ab'.repeat(32));
  });

  test('not delivered keeps the reason; the socket phase never confirms', () => {
    const m = make();
    m.notDelivered('connection_refused', t0 + 5);
    assert.equal(m.state, 'not_delivered');
    assert.equal(m.view().reason, 'connection_refused');
    assert.equal(m.view().sentAt, null);
  });

  test('sent_unconfirmed only after the confirmation window', () => {
    const m = make();
    m.sent(t0);
    assert.throws(() => m.unconfirmed(t0 + CONFIRM_WINDOW_MS - 1), MessageStateError);
    m.unconfirmed(t0 + CONFIRM_WINDOW_MS);
    assert.equal(m.state, 'sent_unconfirmed');
    assert.equal(m.view().reason, 'no_new_turn');
  });

  test('delivered needs the send first, and a turn before the send does not count', () => {
    const m = make();
    assert.throws(() => m.delivered(t0 + 1), MessageStateError);
    m.sent(t0 + 100);
    assert.throws(() => m.delivered(t0 + 50), MessageStateError);
  });

  test('a settled message does not change again (no resend, no second outcome)', () => {
    const m = make();
    m.sent(t0);
    m.delivered(t0 + 1);
    assert.throws(() => m.notDelivered('timeout', t0 + 2), MessageStateError);
    assert.throws(() => m.unconfirmed(t0 + CONFIRM_WINDOW_MS), MessageStateError);
    assert.throws(() => m.sent(t0 + 3), MessageStateError);
  });
});

describe('BurstLimit', () => {
  test('a session gets at most `perSession` in the window, then an honest wait', () => {
    const limit = new BurstLimit({ perSession: 2, total: 10, windowMs: 1000 });
    assert.deepEqual(limit.check('s1', 0), { ok: true });
    limit.record('s1', 0);
    limit.record('s1', 100);
    assert.deepEqual(limit.check('s1', 200), { ok: false, retryAfterMs: 800 });
    assert.deepEqual(limit.check('s2', 200), { ok: true });
    assert.deepEqual(limit.check('s1', 1000), { ok: true });
  });

  test('all sessions together get at most `total`', () => {
    const limit = new BurstLimit({ perSession: 5, total: 2, windowMs: 1000 });
    limit.record('s1', 0);
    limit.record('s2', 10);
    assert.deepEqual(limit.check('s3', 20), { ok: false, retryAfterMs: 980 });
  });
});
