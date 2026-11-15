// The permission request domain (#618): its life from pending to delivered or closed, the refusals the API maps to
// 409/410/422, and what it keeps of the call. Pure: no disk, no socket, no clock (times come in as milliseconds). (#618)
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { digestOf } from '../../src/permissions/digest.ts';
import { EXPIRY_MS, MAX_REASON_CHARS, PermissionRefusal, PermissionRequest, type RefusalCode } from '../../src/permissions/model.ts';

const T = 1_700_000_000_000;
const SECRET_COMMAND = 'DATABASE_URL=postgres://u:pw@h/db npm run migrate';

const open = (over: { toolName?: string; toolInput?: unknown; id?: string } = {}) =>
  PermissionRequest.open({
    id: over.id ?? 'rq-1',
    sessionId: 'S',
    toolName: over.toolName ?? 'Bash',
    toolInput: 'toolInput' in over ? over.toolInput : { command: SECRET_COMMAND },
    cwd: '/w',
    permissionMode: 'default',
    now: T,
  });

const refusal = (code: RefusalCode) => (e: unknown) => e instanceof PermissionRefusal && e.code === code;
const answerAllow = (r: PermissionRequest, now = T + 1_000) => r.answer({ decision: 'allow', answeredBy: 'fernando', channel: 'ui', now });

describe('opening a request (#618/AC-1, AC-7)', () => {
  test('#618/AC-1: it is pending, expires 9 min 30 s after T, and carries the digest of session, tool, input and cwd', async () => {
    const r = await open();
    assert.equal(r.state, 'pending');
    assert.equal(r.createdAt, T);
    assert.equal(EXPIRY_MS, 9 * 60_000 + 30_000);
    assert.equal(r.expiresAt, T + 570_000);
    assert.equal(r.digest, await digestOf({ sessionId: 'S', toolName: 'Bash', toolInput: { command: SECRET_COMMAND }, cwd: '/w' }));
    assert.equal(r.id, 'rq-1');
    assert.equal(r.sessionId, 'S');
    assert.equal(r.toolName, 'Bash');
    assert.equal(r.cwd, '/w');
    assert.equal(r.permissionMode, 'default');
    assert.equal(r.terminalOnly, false);
    assert.equal(r.decision, null);
    assert.equal(r.reason, null);
    assert.equal(r.settledAt, null);
  });

  test('#618/AC-7: the summary has the secret masked and the raw input is nowhere on the aggregate', async () => {
    const r = await open();
    assert.equal(r.summary, 'DATABASE_URL=postgres://••••@h/db npm run migrate');
    const everything = JSON.stringify(r) + JSON.stringify(Object.entries(r)) + Object.getOwnPropertyNames(r).join();
    assert.doesNotMatch(everything, /u:pw/);
    assert.doesNotMatch(everything, /"command"/);
    for (const v of Object.values(r)) assert.notEqual(typeof v === 'object' && v !== null, true, 'no object kept, so no raw toolInput');
  });

  test('#618/AC-7: the request says whether its summary was cut, for the screen to mark it', async () => {
    assert.equal((await open()).summaryTruncated, false);
    assert.equal((await open({ toolInput: { command: `echo ${'a'.repeat(3000)}` } })).summaryTruncated, true);
  });

  test('#618/AC-6: rm -rf and any call citing .ahrena-console open as terminalOnly', async () => {
    assert.equal((await open({ toolInput: { command: 'rm -rf build' } })).terminalOnly, true);
    assert.equal((await open({ toolName: 'Read', toolInput: { file_path: '/Users/u/.ahrena-console/nucleo.json' } })).terminalOnly, true);
  });
});

describe('answering (#618/AC-1, AC-2, AC-6)', () => {
  test('#618/AC-1: allow moves a pending request to answered, with who answered and through what channel', async () => {
    const r = await open();
    answerAllow(r);
    assert.equal(r.state, 'answered');
    assert.equal(r.decision, 'allow');
    assert.equal(r.answeredBy, 'fernando');
    assert.equal(r.channel, 'ui');
    assert.equal(r.reason, null);
    assert.equal(r.settledAt, null);
  });

  test('#618/AC-1: deny keeps a one-line reason', async () => {
    const r = await open();
    r.answer({ decision: 'deny', reason: 'not now', answeredBy: 'fernando', channel: 'ui', now: T + 1 });
    assert.equal(r.state, 'answered');
    assert.equal(r.decision, 'deny');
    assert.equal(r.reason, 'not now');
  });

  test('#618/AC-1: a deny without a reason, or with a blank one, has no reason', async () => {
    const a = await open();
    a.answer({ decision: 'deny', answeredBy: 'f', channel: 'ui', now: T + 1 });
    assert.equal(a.reason, null);
    const b = await open();
    b.answer({ decision: 'deny', reason: '   ', answeredBy: 'f', channel: 'ui', now: T + 1 });
    assert.equal(b.reason, null);
  });

  test('#618/AC-1: the reason is at most 500 characters: 500 is kept, 501 is refused', async () => {
    const ok = await open();
    ok.answer({ decision: 'deny', reason: 'é'.repeat(MAX_REASON_CHARS), answeredBy: 'f', channel: 'ui', now: T + 1 });
    assert.equal(ok.reason?.length, 500);
    const long = await open();
    assert.throws(() => long.answer({ decision: 'deny', reason: 'x'.repeat(MAX_REASON_CHARS + 1), answeredBy: 'f', channel: 'ui', now: T + 1 }), refusal('invalid_reason'));
    assert.equal(long.state, 'pending');
  });

  test('#618/AC-1: a reason with a line break is refused, and so is a reason on an allow', async () => {
    for (const reason of ['a\nb', 'a\rb', 'a b']) {
      const r = await open();
      assert.throws(() => r.answer({ decision: 'deny', reason, answeredBy: 'f', channel: 'ui', now: T + 1 }), refusal('invalid_reason'), JSON.stringify(reason));
    }
    const r = await open();
    assert.throws(() => r.answer({ decision: 'allow', reason: 'why', answeredBy: 'f', channel: 'ui', now: T + 1 }), refusal('invalid_reason'));
  });

  test('#618/AC-1: a decision other than allow or deny, or an answer with no author, is refused', async () => {
    const r = await open();
    assert.throws(() => r.answer({ decision: 'maybe' as 'allow', answeredBy: 'f', channel: 'ui', now: T + 1 }), refusal('invalid_decision'));
    assert.throws(() => r.answer({ decision: 'allow', answeredBy: ' ', channel: 'ui', now: T + 1 }), refusal('invalid_answer'));
    assert.throws(() => r.answer({ decision: 'allow', answeredBy: 'f', channel: 'hub' as 'ui', now: T + 1 }), refusal('invalid_answer'));
    assert.equal(r.state, 'pending');
  });

  test('#618/AC-6: allow is refused on a terminalOnly request, and the request stays pending', async () => {
    const r = await open({ toolInput: { command: 'rm -rf build' } });
    assert.throws(() => answerAllow(r), refusal('terminal_only'));
    assert.equal(r.state, 'pending');
  });

  test('#618/AC-6: allow is refused on a call citing .ahrena-console', async () => {
    const r = await open({ toolInput: { command: 'cat ~/.ahrena-console/nucleo.json' } });
    assert.throws(() => answerAllow(r), refusal('terminal_only'));
  });

  test('#618/AC-6: a deny with a one-line reason is accepted on a terminalOnly request', async () => {
    const r = await open({ toolInput: { command: 'rm -rf build' } });
    r.answer({ decision: 'deny', reason: 'keep the build', answeredBy: 'f', channel: 'ui', now: T + 1 });
    assert.equal(r.state, 'answered');
    assert.equal(r.decision, 'deny');
  });

  test('#618/AC-2: a request answers once: a second answer is refused as already_answered', async () => {
    const r = await open();
    answerAllow(r);
    assert.throws(() => r.answer({ decision: 'deny', answeredBy: 'f', channel: 'ui', now: T + 2 }), refusal('already_answered'));
    assert.equal(r.decision, 'allow');
  });

  test('#618/AC-3: an answer at or after expiresAt is refused as gone', async () => {
    const r = await open();
    assert.throws(() => answerAllow(r, r.expiresAt), refusal('gone'));
    assert.throws(() => answerAllow(r, r.expiresAt + 1), refusal('gone'));
    answerAllow(r, r.expiresAt - 1);
    assert.equal(r.state, 'answered');
  });
});

describe('delivering (#618/AC-2)', () => {
  test('#618/AC-2: delivering an answered request moves it to delivered, once', async () => {
    const r = await open();
    answerAllow(r);
    r.deliver(T + 2_000);
    assert.equal(r.state, 'delivered');
    assert.equal(r.settledAt, T + 2_000);
    assert.equal(r.settledBy, 'hook');
    assert.throws(() => r.deliver(T + 3_000), refusal('already_delivered'));
    assert.equal(r.settledAt, T + 2_000);
  });

  test('#618/AC-2: a delivered request refuses a new answer', async () => {
    const r = await open();
    answerAllow(r);
    r.deliver(T + 2_000);
    assert.throws(() => answerAllow(r, T + 3_000), refusal('already_answered'));
  });

  test('#618/AC-2: a request with no answer yet is not delivered', async () => {
    const r = await open();
    assert.throws(() => r.deliver(T + 1), refusal('not_answered'));
    assert.equal(r.state, 'pending');
  });

  test('#618/AC-3: an answered request is not delivered once expiresAt has passed', async () => {
    const r = await open();
    answerAllow(r);
    assert.throws(() => r.deliver(r.expiresAt), refusal('gone'));
    assert.equal(r.state, 'answered');
  });
});

describe('closing without a delivery (#618/AC-3, AC-4)', () => {
  const closings: [string, (r: PermissionRequest) => void, string, string][] = [
    ['expired', (r) => r.expire(r.expiresAt), 'expired', 'expiry'],
    ['withdrawn', (r) => r.withdraw(T + 5_000), 'withdrawn', 'hook'],
    ['answered_elsewhere', (r) => r.closeElsewhere(T + 5_000), 'answered_elsewhere', 'session_event'],
    ['core_restarted', (r) => r.closeAfterRestart(T + 5_000), 'core_restarted', 'core_restart'],
  ];

  for (const [name, close, state, by] of closings) {
    test(`#618/AC-3: a pending request closed as ${name} refuses answer and delivery as gone`, async () => {
      const r = await open();
      close(r);
      assert.equal(r.state, state);
      assert.equal(r.settledBy, by);
      assert.notEqual(r.settledAt, null);
      assert.throws(() => answerAllow(r, T + 6_000), refusal('gone'));
      assert.throws(() => r.deliver(T + 6_000), refusal('gone'));
    });
  }

  for (const [name, close, state] of closings.filter(([n]) => n !== 'withdrawn')) {
    test(`#618/AC-4: an answered, undelivered request closed as ${name} is never delivered`, async () => {
      const r = await open();
      answerAllow(r);
      close(r);
      assert.equal(r.state, state);
      assert.equal(r.decision, 'allow', 'the answer stays on record');
      assert.throws(() => r.deliver(T + 6_000), refusal('gone'));
    });
  }

  test('#618/AC-4: an answered request the hook withdraws is closed as withdrawn and not delivered', async () => {
    const r = await open();
    answerAllow(r);
    r.withdraw(T + 5_000);
    assert.equal(r.state, 'withdrawn');
    assert.throws(() => r.deliver(T + 6_000), refusal('gone'));
  });

  test('#618/AC-3: a request cannot expire before its time', async () => {
    const r = await open();
    assert.throws(() => r.expire(r.expiresAt - 1), refusal('not_due'));
    assert.equal(r.state, 'pending');
  });

  test('#618/AC-4: a delivered request is past closing: the session event or the restart cannot take it back', async () => {
    const r = await open();
    answerAllow(r);
    r.deliver(T + 2_000);
    assert.throws(() => r.closeElsewhere(T + 3_000), refusal('already_delivered'));
    assert.throws(() => r.closeAfterRestart(T + 3_000), refusal('already_delivered'));
    assert.throws(() => r.withdraw(T + 3_000), refusal('already_delivered'));
    assert.throws(() => r.expire(r.expiresAt), refusal('already_delivered'));
    assert.equal(r.state, 'delivered');
  });

  test('#618/AC-3: a request already closed cannot be closed again', async () => {
    const r = await open();
    r.withdraw(T + 1);
    for (const again of [() => r.withdraw(T + 2), () => r.closeElsewhere(T + 2), () => r.closeAfterRestart(T + 2), () => r.expire(r.expiresAt)]) {
      assert.throws(again, refusal('gone'));
    }
    assert.equal(r.state, 'withdrawn');
    assert.equal(r.settledAt, T + 1);
  });

  test('#618/AC-3: isOpen says whether a request can still change: pending or answered, not delivered or closed', async () => {
    const r = await open();
    assert.equal(r.isOpen, true);
    answerAllow(r);
    assert.equal(r.isOpen, true);
    r.deliver(T + 2_000);
    assert.equal(r.isOpen, false);
    const w = await open({ id: 'rq-2' });
    w.withdraw(T + 1);
    assert.equal(w.isOpen, false);
  });
});

describe('the refusal (#618/AC-2, AC-3, AC-6)', () => {
  test('a refusal is a typed error whose code the API maps to its status', async () => {
    const r = await open();
    try {
      r.deliver(T + 1);
      assert.fail('should refuse');
    } catch (e) {
      assert.ok(e instanceof PermissionRefusal);
      assert.ok(e instanceof Error);
      assert.equal(e.code, 'not_answered');
    }
  });
});
