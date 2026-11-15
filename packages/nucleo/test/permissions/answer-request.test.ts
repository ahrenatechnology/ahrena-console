// answerRequest and withdrawRequest against fakes for the ports (#618, layer 2).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';
import { PermissionNotFound } from '../../src/permissions/errors.ts';
import { PermissionRefusal, type RefusalCode } from '../../src/permissions/model.ts';
import { answerRequest } from '../../src/permissions/answer-request.ts';
import { registerRequest } from '../../src/permissions/register-request.ts';
import { waitForDecision } from '../../src/permissions/wait-for-decision.ts';
import { withdrawRequest } from '../../src/permissions/withdraw-request.ts';
import { harness, registerInput, type Harness } from './fakes.ts';

const refusal = (code: RefusalCode) => (e: unknown) => e instanceof PermissionRefusal && e.code === code;
const base = { sessionId: 'S1', requestId: 'rq-1', answeredBy: 'owner', channel: 'ui' } as const;
const registered = async (toolInput: unknown = { command: 'npm run migrate' }) => {
  const h = harness();
  await registerRequest(h, await registerInput({ toolInput }));
  return h;
};

describe('answerRequest (#618/AC-1, AC-2, AC-6, AC-7)', () => {
  test('#618/AC-2: allow and deny with a reason are stored and the change feed is told', async () => {
    const h = await registered();
    answerRequest(h, { ...base, decision: 'deny', reason: 'later' });
    const r = h.repository.find('S1', 'rq-1');
    assert.equal(r?.state, 'answered');
    assert.equal(r?.decision, 'deny');
    assert.equal(r?.reason, 'later');
    assert.deepEqual(h.notifier.published.at(-1), { sessionId: 'S1', requestId: 'rq-1', state: 'answered' });
  });

  test('#618/AC-6: allow on a terminalOnly request is refused and changes nothing', async () => {
    const h = await registered({ command: 'git push --force' });
    assert.throws(() => answerRequest(h, { ...base, decision: 'allow' }), refusal('terminal_only'));
    assert.equal(h.repository.find('S1', 'rq-1')?.state, 'pending');
    assert.equal(h.audit.records.at(-1)?.event, 'refused');
    assert.equal(h.audit.records.at(-1)?.code, 'terminal_only');
    answerRequest(h, { ...base, decision: 'deny' });
    assert.equal(h.repository.find('S1', 'rq-1')?.state, 'answered');
  });

  test('#618/AC-6: allow on a command that cites .ahrena-console is refused', async () => {
    const h = await registered({ command: 'cat ~/.ahrena-console/nucleo.json' });
    assert.throws(() => answerRequest(h, { ...base, decision: 'allow' }), refusal('terminal_only'));
  });

  test('#618/AC-2: a second answer is already_answered, also after the delivery', async () => {
    const h = await registered();
    answerRequest(h, { ...base, decision: 'allow' });
    assert.throws(() => answerRequest(h, { ...base, decision: 'deny' }), refusal('already_answered'));
    await waitForDecision(h, { sessionId: 'S1', requestId: 'rq-1', waitMs: 0 });
    assert.throws(() => answerRequest(h, { ...base, decision: 'deny' }), refusal('already_answered'));
  });

  test('#618/AC-3: an answer to a closed or expired request is gone', async () => {
    const h = await registered();
    withdrawRequest(h, { sessionId: 'S1', requestId: 'rq-1' });
    assert.throws(() => answerRequest(h, { ...base, decision: 'allow' }), refusal('gone'));
    const late = await registered();
    await late.clock.advance(9 * 60_000 + 30_000);
    assert.throws(() => answerRequest(late, { ...base, decision: 'allow' }), refusal('gone'));
    assert.equal(late.repository.find('S1', 'rq-1')?.state, 'expired');
  });

  test('#618/AC-1: the id of another session, or an unknown id, is not found and nothing changes', async () => {
    const h = await registered();
    assert.throws(() => answerRequest(h, { ...base, sessionId: 'S2', decision: 'allow' }), PermissionNotFound);
    assert.throws(() => answerRequest(h, { ...base, requestId: 'rq-9', decision: 'allow' }), PermissionNotFound);
    assert.equal(h.repository.find('S1', 'rq-1')?.state, 'pending');
  });

  test('#618/AC-2: an invalid reason or decision is refused by the domain', async () => {
    const h = await registered();
    assert.throws(() => answerRequest(h, { ...base, decision: 'deny', reason: 'a\nb' }), refusal('invalid_reason'));
    assert.throws(() => answerRequest(h, { ...base, decision: 'maybe' as 'allow' }), refusal('invalid_decision'));
  });

  test('#618/AC-7: the audit of an answer carries the decision and who, the reason only as SHA-256', async () => {
    const h = await registered();
    answerRequest(h, { ...base, decision: 'deny', reason: 'plain words hunter2pw' });
    const rec = h.audit.records.find((r) => r.event === 'answered');
    assert.equal(rec?.decision, 'deny');
    assert.equal(rec?.answeredBy, 'owner');
    assert.equal(rec?.channel, 'ui');
    assert.equal(rec?.reasonSha256, createHash('sha256').update('plain words hunter2pw').digest('hex'));
    assert.doesNotMatch(JSON.stringify(h.audit.records), /plain words|hunter2pw|migrate|summary|toolInput/);
  });

  test('#618/AC-7: an answer with no reason audits a null hash', async () => {
    const h = await registered();
    answerRequest(h, { ...base, decision: 'allow' });
    assert.equal(h.audit.records.find((r) => r.event === 'answered')?.reasonSha256, null);
  });
});

describe('withdrawRequest (#618/AC-3)', () => {
  test('#618/AC-3: the hook giving up closes the request as withdrawn and audits it', async () => {
    const h = await registered();
    withdrawRequest(h, { sessionId: 'S1', requestId: 'rq-1' });
    assert.equal(h.repository.find('S1', 'rq-1')?.state, 'withdrawn');
    assert.deepEqual(h.notifier.published.at(-1), { sessionId: 'S1', requestId: 'rq-1', state: 'withdrawn' });
    const rec = h.audit.records.at(-1);
    assert.equal(rec?.event, 'closed');
    assert.equal(rec?.settledBy, 'hook');
  });

  test('#618/AC-3: an answered request not yet delivered can be withdrawn; a delivered one cannot', async () => {
    const h = await registered();
    answerRequest(h, { ...base, decision: 'allow' });
    withdrawRequest(h, { sessionId: 'S1', requestId: 'rq-1' });
    assert.equal(h.repository.find('S1', 'rq-1')?.state, 'withdrawn');
    const d = await registered();
    answerRequest(d, { ...base, decision: 'allow' });
    await waitForDecision(d, { sessionId: 'S1', requestId: 'rq-1', waitMs: 0 });
    assert.throws(() => withdrawRequest(d, { sessionId: 'S1', requestId: 'rq-1' }), refusal('already_delivered'));
  });

  test('#618/AC-1: another session cannot withdraw it', async () => {
    const h = await registered();
    assert.throws(() => withdrawRequest(h, { sessionId: 'S2', requestId: 'rq-1' }), PermissionNotFound);
    assert.equal(h.repository.find('S1', 'rq-1')?.state, 'pending');
  });
});
