// waitForDecision, the long poll, driven through the clock and notifier fakes: no real waiting (#618, layer 2).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { PermissionNotFound } from '../../src/permissions/errors.ts';
import { PermissionRefusal, type RefusalCode } from '../../src/permissions/model.ts';
import { answerRequest } from '../../src/permissions/answer-request.ts';
import { registerRequest } from '../../src/permissions/register-request.ts';
import { MAX_WAIT_MS, waitForDecision } from '../../src/permissions/wait-for-decision.ts';
import { withdrawRequest } from '../../src/permissions/withdraw-request.ts';
import { expireDue, sweepOnStart } from '../../src/permissions/expire-due.ts';
import { settleFromHookEvent } from '../../src/permissions/settle-from-hook-event.ts';
import { harness, registerInput, settle, type Harness } from './fakes.ts';

const refusal = (code: RefusalCode) => (e: unknown) => e instanceof PermissionRefusal && e.code === code;
const answer = (h: Harness, decision: 'allow' | 'deny' = 'allow', reason?: string) => answerRequest(h, { sessionId: 'S1', requestId: 'rq-1', decision, reason, answeredBy: 'owner', channel: 'ui' });
const wait = (h: Harness, waitMs = 25_000, sessionId = 'S1', requestId = 'rq-1') => waitForDecision(h, { sessionId, requestId, waitMs });
const registered = async () => {
  const h = harness();
  await registerRequest(h, await registerInput());
  return h;
};

describe('waitForDecision (#618/AC-2, AC-3)', () => {
  test('#618/AC-2: an answered request is delivered at once, with the stored digest, and a second read is already_delivered', async () => {
    const h = await registered();
    answer(h, 'deny', 'not now');
    const stored = h.repository.find('S1', 'rq-1');
    const first = await wait(h);
    assert.deepEqual(first, { kind: 'decision', requestId: 'rq-1', digest: stored?.digest, decision: 'deny', reason: 'not now', answeredBy: 'owner', channel: 'ui' });
    assert.equal(stored?.state, 'delivered');
    await assert.rejects(wait(h), refusal('already_delivered'));
  });

  test('#618/AC-2: two readers racing for one answer: one gets it, the other is already_delivered', async () => {
    const h = await registered();
    answer(h);
    const results = await Promise.allSettled([wait(h), wait(h)]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
  });

  test('#618/AC-2: pending at the deadline is "still pending", after 25 s of fake time and no real wait', async () => {
    const h = await registered();
    const polling = wait(h, 25_000);
    await settle();
    assert.equal(h.clock.activeTimers, 1);
    await h.clock.advance(24_999);
    let done = false;
    void polling.then(() => (done = true));
    await settle();
    assert.equal(done, false);
    await h.clock.advance(1);
    assert.deepEqual(await polling, { kind: 'pending' });
    assert.equal(h.clock.activeTimers, 0, 'the timer is cancelled or fired');
    assert.equal(h.notifier.listening, 0, 'nobody is left listening');
  });

  test('#618/AC-2: the wait is capped at 25 s whatever the caller asks', async () => {
    const h = await registered();
    const polling = wait(h, 10 * 60_000);
    await settle();
    await h.clock.advance(MAX_WAIT_MS);
    assert.deepEqual(await polling, { kind: 'pending' });
  });

  test('#618/AC-2: an answer given during the wait wakes it and is delivered once', async () => {
    const h = await registered();
    const polling = wait(h);
    await settle();
    answer(h, 'allow');
    const out = await polling;
    assert.equal(out.kind, 'decision');
    assert.equal(h.repository.find('S1', 'rq-1')?.state, 'delivered');
    assert.equal(h.notifier.listening, 0);
    assert.equal(h.clock.activeTimers, 0);
  });

  test('#618/AC-3: a wait with no time left returns pending at once', async () => {
    const h = await registered();
    assert.deepEqual(await wait(h, 0), { kind: 'pending' });
  });

  test('#618/AC-3: withdrawn, answered elsewhere, expired and restarted are gone, never delivered', async () => {
    for (const close of [
      (h: Harness) => withdrawRequest(h, { sessionId: 'S1', requestId: 'rq-1' }),
      (h: Harness) => settleFromHookEvent(h, { name: 'Stop', sessionId: 'S1' }),
      (h: Harness) => sweepOnStart(h),
    ]) {
      const h = await registered();
      answer(h);
      await close(h);
      await assert.rejects(wait(h), refusal('gone'));
      assert.notEqual(h.repository.find('S1', 'rq-1')?.state, 'delivered');
    }
    const h = await registered();
    await h.clock.advance(9 * 60_000 + 30_000);
    expireDue(h);
    await assert.rejects(wait(h), refusal('gone'));
  });

  test('#618/AC-3: a wait that reaches the request deadline settles it as expired and answers gone', async () => {
    const h = await registered();
    await h.clock.advance(9 * 60_000 + 20_000);
    const outcome = assert.rejects(wait(h, 25_000), refusal('gone'));
    await settle();
    await h.clock.advance(10_000);
    await outcome;
    assert.equal(h.repository.find('S1', 'rq-1')?.state, 'expired');
    assert.equal(h.clock.activeTimers, 0);
  });

  test('#618/AC-3: an answered request past its expiry is expired, not delivered', async () => {
    const h = await registered();
    answer(h);
    await h.clock.advance(9 * 60_000 + 30_000);
    await assert.rejects(wait(h), refusal('gone'));
    assert.equal(h.repository.find('S1', 'rq-1')?.state, 'expired');
  });

  test('#618/AC-3: a request closed during the wait ends it with gone', async () => {
    const h = await registered();
    const polling = wait(h);
    const outcome = assert.rejects(polling, refusal('gone'));
    await settle();
    withdrawRequest(h, { sessionId: 'S1', requestId: 'rq-1' });
    await outcome;
  });

  test('#618/AC-1: the id of another session, or an unknown id, is not found', async () => {
    const h = await registered();
    answer(h);
    await assert.rejects(wait(h, 25_000, 'S2', 'rq-1'), PermissionNotFound);
    await assert.rejects(wait(h, 25_000, 'S1', 'rq-9'), PermissionNotFound);
    assert.equal(h.repository.find('S1', 'rq-1')?.state, 'answered', 'the other session did not take it');
  });

  test('#618/AC-7: the audit of a delivery carries the digest and no decision text, summary or reason', async () => {
    const h = await registered();
    answer(h, 'deny', 'because of the secret hunter2pw');
    await wait(h);
    const delivered = h.audit.records.find((r) => r.event === 'delivered');
    assert.ok(delivered);
    assert.doesNotMatch(JSON.stringify(h.audit.records), /hunter2pw|because|migrate/);
  });
});
