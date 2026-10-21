// The messaging use cases (#61) with doubles for the ports: availability, sending, the confirmation by
// the session's new turn, the honest refusals and the audit. No disk, no socket, a fake clock.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';
import { CONFIRM_WINDOW_MS, type LiveProcess } from '../../src/messaging/model.ts';
import type { AuditEntry, DeliveryResult, TurnProbe } from '../../src/messaging/ports.ts';
import { Messaging } from '../../src/messaging/service.ts';

const SECRET = 'texto-secreto-que-nunca-vai-para-log-42';
const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');
const proc = (pid: number, extra: Partial<LiveProcess> = {}): LiveProcess => ({ pid, socketPath: `/fake/${pid}.sock`, configDir: '/fake/config', accountId: null, entrypoint: 'claude-desktop', remoteControl: false, ...extra });

interface Setup {
  processes?: LiveProcess[];
  delivery?: DeliveryResult;
  /** When (ms after the send) the probe reports the turn; `null` never. */
  turnAfterMs?: number | null;
  platform?: string;
}

function setup({ processes = [proc(41)], delivery = { ok: true }, turnAfterMs = 500, platform = 'darwin' }: Setup = {}) {
  let clock = Date.parse('2026-10-21T10:00:00.000Z');
  const calls: string[] = [];
  const delivered: { socketPath: string; text: string }[] = [];
  const audit: AuditEntry[] = [];
  const logs: string[] = [];
  let sentAt: number | null = null;
  let closed = 0;
  let ids = 0;
  const probe: TurnProbe = {
    async poll() {
      calls.push('poll');
      if (sentAt === null || turnAfterMs === null) return null;
      return clock - sentAt >= turnAfterMs ? sentAt + turnAfterMs : null;
    },
    close() {
      closed++;
    },
  };
  const messaging = new Messaging({
    live: { find: async () => (calls.push('find'), processes) },
    inbox: {
      deliver: async (socketPath, text) => {
        calls.push('deliver');
        delivered.push({ socketPath, text });
        if (delivery.ok) sentAt = clock;
        return delivery;
      },
    },
    turns: { open: async () => (calls.push('open'), probe) },
    audit: { record: (e) => audit.push(e) },
    platform,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      await new Promise((r) => setImmediate(r));
    },
    newId: () => `m${++ids}`,
    pollMs: 250,
    log: (m) => logs.push(m),
  });
  return { messaging, calls, delivered, audit, logs, advance: (ms: number) => (clock += ms), closedProbes: () => closed };
}

/** Waits for the background confirmation to settle the message. */
async function settled(messaging: Messaging, sessionId: string, messageId: string) {
  for (let i = 0; i < 10_000; i++) {
    const m = messaging.message(sessionId, messageId);
    if (m && m.state !== 'sending') return m;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error('never settled');
}

describe('Messaging.availability (#61/AC-1)', () => {
  test('one live process: available, with entrypoint and Remote Control, no socket nor pid', async () => {
    const { messaging } = setup({ processes: [proc(41, { remoteControl: true })] });
    const a = await messaging.availability('s1');
    assert.deepEqual(a, { available: true, reason: null, entrypoint: 'claude-desktop', remoteControl: true, configDir: 'config', accountId: null, processes: 1, inFlight: null });
    assert.equal(JSON.stringify(a).includes('/fake'), false);
  });

  test('the folder name and the account of the live process, never the folder path', async () => {
    const { messaging } = setup({ processes: [proc(41, { configDir: '/home/x/.claude-team', accountId: 'acc/org' })] });
    const a = await messaging.availability('s1');
    assert.deepEqual([a.configDir, a.accountId], ['.claude-team', 'acc/org']);
  });

  test('none, two and another machine say why', async () => {
    assert.equal((await setup({ processes: [] }).messaging.availability('s1')).reason, 'no_live_process');
    assert.deepEqual(await setup({ processes: [proc(1), proc(2)] }).messaging.availability('s1'), { available: false, reason: 'ambiguous', entrypoint: null, remoteControl: false, configDir: null, accountId: null, processes: 2, inFlight: null });
    assert.equal((await setup().messaging.availability('s1', { otherMachine: true })).reason, 'other_machine');
    assert.equal((await setup({ platform: 'win32' }).messaging.availability('s1')).reason, 'unsupported_platform');
  });
});

describe('Messaging.send (#61/AC-1, #61/AC-2)', () => {
  test('delivers to the one live process and confirms by the new turn; the probe opens before the send', async () => {
    const { messaging, calls, delivered, audit } = setup();
    const r = await messaging.send('s1', SECRET);
    assert.equal(r.kind, 'accepted');
    if (r.kind !== 'accepted') return;
    assert.equal(r.message.state, 'sending');
    assert.deepEqual(delivered, [{ socketPath: '/fake/41.sock', text: SECRET }]);
    assert.ok(calls.indexOf('open') < calls.indexOf('deliver'), calls.join(','));
    const m = await settled(messaging, 's1', r.message.messageId);
    assert.equal(m.state, 'delivered');
    assert.equal(m.deliveredAt, '2026-10-21T10:00:00.500Z');
    assert.deepEqual(audit, [{ at: m.settledAt, sessionId: 's1', messageId: r.message.messageId, mechanism: 'inbox', outcome: 'delivered', reason: null, textSha256: sha(SECRET) }]);
  });

  test('without a new turn in 60 s: sent_unconfirmed, never resent', async () => {
    const { messaging, delivered, audit, closedProbes } = setup({ turnAfterMs: null });
    const r = await messaging.send('s1', SECRET);
    assert.equal(r.kind, 'accepted');
    if (r.kind !== 'accepted') return;
    const m = await settled(messaging, 's1', r.message.messageId);
    assert.equal(m.state, 'sent_unconfirmed');
    assert.equal(m.reason, 'no_new_turn');
    assert.ok(Date.parse(m.settledAt!) - Date.parse(m.sentAt!) >= CONFIRM_WINDOW_MS);
    assert.equal(delivered.length, 1);
    assert.equal(audit[0].outcome, 'sent_unconfirmed');
    assert.equal(closedProbes(), 1);
  });

  test('a socket failure is not_delivered right away, with the reason', async () => {
    const { messaging, audit } = setup({ delivery: { ok: false, reason: 'connection_refused' } });
    const r = await messaging.send('s1', SECRET);
    assert.equal(r.kind === 'accepted' && r.message.state, 'not_delivered');
    assert.equal(r.kind === 'accepted' && r.message.reason, 'connection_refused');
    assert.equal(audit[0].outcome, 'not_delivered');
    assert.equal(audit[0].reason, 'connection_refused');
  });

  test('no live process or two: not_delivered without touching any socket', async () => {
    for (const [processes, reason] of [[[], 'no_live_process'], [[proc(1), proc(2)], 'ambiguous']] as const) {
      const { messaging, delivered } = setup({ processes: [...processes] });
      const r = await messaging.send('s1', SECRET);
      assert.equal(r.kind === 'accepted' && r.message.reason, reason);
      assert.equal(delivered.length, 0);
    }
  });

  test('invalid text is refused before anything happens', async () => {
    const { messaging, calls, audit } = setup();
    for (const bad of ['', '  ', 'a'.repeat(16 * 1024 + 1), 7]) {
      const r = await messaging.send('s1', bad);
      assert.deepEqual(r.kind === 'refused' && r.refusal, 'invalid_text');
    }
    assert.deepEqual(calls, []);
    assert.equal(audit.every((e) => e.outcome === 'refused' && e.reason === 'invalid_text'), true);
  });

  test('one in flight per session: the second waits for the first to settle', async () => {
    const { messaging } = setup({ turnAfterMs: 1000 });
    const first = await messaging.send('s1', 'um');
    assert.equal(first.kind, 'accepted');
    const second = await messaging.send('s1', 'dois');
    assert.equal(second.kind === 'refused' && second.refusal, 'in_flight');
    assert.equal(second.kind === 'refused' && second.messageId, first.kind === 'accepted' && first.message.messageId);
    assert.equal((await messaging.availability('s1')).inFlight, first.kind === 'accepted' && first.message.messageId);
    // Another session is not held by it.
    assert.equal((await messaging.send('s2', 'outra')).kind, 'accepted');
    await settled(messaging, 's1', first.kind === 'accepted' ? first.message.messageId : '');
    assert.equal((await messaging.send('s1', 'tres')).kind, 'accepted');
  });

  test('a burst is refused with how long to wait', async () => {
    const { messaging, advance } = setup({ delivery: { ok: false, reason: 'socket_gone' } });
    for (let i = 0; i < 5; i++) assert.equal((await messaging.send('s1', `m${i}`)).kind, 'accepted');
    const r = await messaging.send('s1', 'mais um');
    assert.equal(r.kind === 'refused' && r.refusal, 'rate_limited');
    assert.ok(r.kind === 'refused' && r.retryAfterMs! > 0);
    advance(60_000);
    assert.equal((await messaging.send('s1', 'depois')).kind, 'accepted');
  });

  test('the text never reaches the log nor the audit, only its hash', async () => {
    const { messaging, audit, logs } = setup({ turnAfterMs: null });
    const r = await messaging.send('s1', SECRET);
    await settled(messaging, 's1', r.kind === 'accepted' ? r.message.messageId : '');
    await messaging.send('s1', 'a'.repeat(20_000) + SECRET);
    const all = JSON.stringify(audit) + logs.join('\n') + JSON.stringify(r);
    assert.equal(all.includes(SECRET), false);
    assert.ok(audit.some((e) => e.textSha256 === sha(SECRET)));
    assert.ok(logs.length > 0);
  });

  test('after close, a request is refused and nothing is written', async () => {
    const { messaging, delivered } = setup();
    messaging.close();
    const r = await messaging.send('s1', 'oi');
    assert.equal(r.kind === 'refused' && r.refusal, 'closing');
    assert.equal(delivered.length, 0);
  });

  test('failing to list the processes is no_live_process, and the session is free again', async () => {
    const { messaging } = setup();
    (messaging as unknown as { live: { find: () => Promise<never> } }).live = { find: async () => Promise.reject(new Error('profiles broke')) };
    const r = await messaging.send('s1', 'oi');
    assert.deepEqual(r.kind === 'accepted' && [r.message.state, r.message.reason], ['not_delivered', 'no_live_process']);
    assert.equal((await messaging.availability('s1')).reason, 'no_live_process');
    assert.equal((await messaging.availability('s1')).inFlight, null);
  });

  test('an audit that throws during the confirmation neither crashes the core nor keeps the session busy', async () => {
    const { messaging } = setup();
    (messaging as unknown as { audit: { record: () => void } }).audit = {
      record: () => {
        throw new Error('disk full');
      },
    };
    const r = await messaging.send('s1', 'oi');
    assert.equal(r.kind, 'accepted');
    for (let i = 0; i < 1000 && (await messaging.availability('s1')).inFlight; i++) await new Promise((res) => setImmediate(res));
    assert.equal((await messaging.availability('s1')).inFlight, null);
  });

  test('a message is only read through its own session', async () => {
    const { messaging } = setup();
    const r = await messaging.send('s1', 'oi');
    const id = r.kind === 'accepted' ? r.message.messageId : '';
    assert.equal(messaging.message('s1', id)?.messageId, id);
    assert.equal(messaging.message('s2', id), null);
    assert.equal(messaging.message('s1', 'nope'), null);
  });
});
