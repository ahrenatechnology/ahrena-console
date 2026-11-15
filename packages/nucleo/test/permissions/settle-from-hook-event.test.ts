// settleFromHookEvent, expireDue, sweepOnStart and the listing, against fakes for the ports (#618, layer 2).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { answerRequest } from '../../src/permissions/answer-request.ts';
import { expireDue, sweepOnStart } from '../../src/permissions/expire-due.ts';
import { listRequests, RECENT_MS } from '../../src/permissions/list-requests.ts';
import { registerRequest } from '../../src/permissions/register-request.ts';
import { settleFromHookEvent } from '../../src/permissions/settle-from-hook-event.ts';
import { waitForDecision } from '../../src/permissions/wait-for-decision.ts';
import { withdrawRequest } from '../../src/permissions/withdraw-request.ts';
import { harness, PLAIN, registerInput, T0, type Harness } from './fakes.ts';

const state = (h: Harness, id: string, sessionId = 'S1') => h.repository.find(sessionId, id)?.state;
const call = { sessionId: 'S1', toolName: 'Bash', toolInput: PLAIN, cwd: '/w' };
const pre = (toolUseId: string, over: Partial<typeof call> = {}) => ({ name: 'PreToolUse' as const, ...call, ...over, toolUseId });
const post = (toolUseId: string, over: Partial<typeof call> = {}) => ({ name: 'PostToolUse' as const, ...call, ...over, toolUseId });
const register = async (h: Harness, over: Parameters<typeof registerInput>[0] = {}) => (await registerRequest(h, await registerInput(over))).requestId;

describe('settleFromHookEvent (#618/AC-4)', () => {
  test('#618/AC-4: PostToolUse of the call learned from its PreToolUse closes it as answered_elsewhere', async () => {
    const h = harness();
    const id = await register(h);
    await settleFromHookEvent(h, pre('tu-1'));
    assert.equal(h.repository.toolUseOf(id), 'tu-1');
    assert.equal(state(h, id), 'pending');
    assert.deepEqual(await settleFromHookEvent(h, post('tu-1')), { closed: [id] });
    assert.equal(state(h, id), 'answered_elsewhere');
    assert.deepEqual(h.notifier.published.at(-1), { sessionId: 'S1', requestId: id, state: 'answered_elsewhere' });
    const rec = h.audit.records.at(-1);
    assert.equal(rec?.event, 'closed');
    assert.equal(rec?.settledBy, 'session_event');
  });

  test('#618/AC-4: PostToolUseFailure closes it too', async () => {
    const h = harness();
    const id = await register(h);
    await settleFromHookEvent(h, pre('tu-1'));
    await settleFromHookEvent(h, { ...post('tu-1'), name: 'PostToolUseFailure' });
    assert.equal(state(h, id), 'answered_elsewhere');
  });

  test('#618/AC-4: the pairing of equal calls is in arrival order, the oldest request with the first PreToolUse', async () => {
    const h = harness();
    const a = await register(h);
    await h.clock.advance(1);
    const b = await register(h);
    await settleFromHookEvent(h, pre('tu-1'));
    await settleFromHookEvent(h, pre('tu-2'));
    assert.equal(h.repository.toolUseOf(a), 'tu-1');
    assert.equal(h.repository.toolUseOf(b), 'tu-2');
    await settleFromHookEvent(h, post('tu-2'));
    assert.equal(state(h, a), 'pending');
    assert.equal(state(h, b), 'answered_elsewhere');
  });

  test('#618/AC-4: a PreToolUse of another tool, digest or session pairs with nothing', async () => {
    const h = harness();
    const id = await register(h);
    await settleFromHookEvent(h, pre('tu-1', { toolName: 'Edit' }));
    await settleFromHookEvent(h, pre('tu-2', { toolInput: { command: 'ls' } }));
    await settleFromHookEvent(h, pre('tu-3', { sessionId: 'S2' }));
    assert.equal(h.repository.toolUseOf(id), null);
  });

  test('#618/AC-4: a PostToolUse with no pair closes the oldest open request of the same call, and none of another', async () => {
    const h = harness();
    const other = await register(h, { toolInput: { command: 'ls' } });
    const a = await register(h);
    await h.clock.advance(1);
    const b = await register(h);
    await settleFromHookEvent(h, post('tu-9'));
    assert.equal(state(h, a), 'answered_elsewhere');
    assert.equal(state(h, b), 'pending');
    assert.equal(state(h, other), 'pending');
  });

  test('#618/AC-4: a PostToolUse of a call already linked to a closed request closes nothing else', async () => {
    const h = harness();
    const a = await register(h);
    const b = await register(h);
    await settleFromHookEvent(h, pre('tu-1'));
    await settleFromHookEvent(h, post('tu-1'));
    assert.deepEqual(await settleFromHookEvent(h, post('tu-1')), { closed: [] });
    assert.equal(state(h, a), 'answered_elsewhere');
    assert.equal(state(h, b), 'pending');
  });

  test('#618/AC-4: Stop, UserPromptSubmit and SessionEnd close every open request of the session only', async () => {
    for (const name of ['Stop', 'UserPromptSubmit', 'SessionEnd'] as const) {
      const h = harness();
      const a = await register(h);
      const b = await register(h, { toolInput: { command: 'ls' } });
      const s2 = await register(h, { sessionId: 'S2' });
      const out = await settleFromHookEvent(h, { name, sessionId: 'S1' });
      assert.deepEqual(out.closed.sort(), [a, b].sort(), name);
      assert.equal(state(h, a), 'answered_elsewhere');
      assert.equal(state(h, b), 'answered_elsewhere');
      assert.equal(state(h, s2, 'S2'), 'pending');
    }
  });

  test('#618/AC-4: an answered request that was not delivered closes as well, and is then gone', async () => {
    const h = harness();
    const id = await register(h);
    answerRequest(h, { sessionId: 'S1', requestId: id, decision: 'allow', answeredBy: 'owner', channel: 'ui' });
    await settleFromHookEvent(h, { name: 'Stop', sessionId: 'S1' });
    assert.equal(state(h, id), 'answered_elsewhere');
    await assert.rejects(waitForDecision(h, { sessionId: 'S1', requestId: id, waitMs: 0 }), (e: unknown) => (e as { code?: string }).code === 'gone');
  });

  test('#618/AC-4: a delivered or already closed request is left as it is', async () => {
    const h = harness();
    const id = await register(h);
    answerRequest(h, { sessionId: 'S1', requestId: id, decision: 'allow', answeredBy: 'owner', channel: 'ui' });
    await waitForDecision(h, { sessionId: 'S1', requestId: id, waitMs: 0 });
    assert.deepEqual(await settleFromHookEvent(h, { name: 'Stop', sessionId: 'S1' }), { closed: [] });
    assert.equal(state(h, id), 'delivered');
  });

  test('#618/AC-4: an event whose input is nested too deep to digest is ignored', async () => {
    const h = harness();
    const id = await register(h);
    let deep: unknown = 'x';
    for (let i = 0; i < 70; i += 1) deep = { a: deep };
    assert.deepEqual(await settleFromHookEvent(h, post('tu-1', { toolInput: deep })), { closed: [] });
    assert.equal(state(h, id), 'pending');
  });

  test('#618/AC-7: the audit of a closing carries no input, summary or reason', async () => {
    const h = harness();
    await register(h, { toolInput: { command: 'echo hunter2pw' } });
    await settleFromHookEvent(h, { name: 'Stop', sessionId: 'S1' });
    assert.doesNotMatch(JSON.stringify(h.audit.records), /hunter2pw|echo|summary|toolInput/);
  });
});

describe('expireDue and sweepOnStart (#618/AC-3)', () => {
  test('#618/AC-3: only the requests at or past their deadline expire', async () => {
    const h = harness();
    const a = await register(h);
    await h.clock.advance(60_000);
    const b = await register(h);
    await h.clock.advance(9 * 60_000 + 30_000 - 60_000);
    assert.deepEqual(expireDue(h), [a]);
    assert.equal(state(h, a), 'expired');
    assert.equal(state(h, b), 'pending');
    assert.deepEqual(h.notifier.published.at(-1), { sessionId: 'S1', requestId: a, state: 'expired' });
    assert.equal(h.audit.records.at(-1)?.settledBy, 'expiry');
    assert.deepEqual(expireDue(h), []);
  });

  test('#618/AC-3: an answered request past its deadline expires too', async () => {
    const h = harness();
    const id = await register(h);
    answerRequest(h, { sessionId: 'S1', requestId: id, decision: 'deny', answeredBy: 'owner', channel: 'ui' });
    await h.clock.advance(9 * 60_000 + 30_000);
    assert.deepEqual(expireDue(h), [id]);
  });

  test('#618/AC-3: on start every pending or answered request becomes core_restarted and is never delivered', async () => {
    const h = harness();
    const p = await register(h);
    const a = await register(h);
    answerRequest(h, { sessionId: 'S1', requestId: a, decision: 'allow', answeredBy: 'owner', channel: 'ui' });
    const d = await register(h);
    answerRequest(h, { sessionId: 'S1', requestId: d, decision: 'allow', answeredBy: 'owner', channel: 'ui' });
    await waitForDecision(h, { sessionId: 'S1', requestId: d, waitMs: 0 });
    const w = await register(h);
    withdrawRequest(h, { sessionId: 'S1', requestId: w });
    assert.deepEqual(sweepOnStart(h).sort(), [p, a].sort());
    assert.equal(state(h, p), 'core_restarted');
    assert.equal(state(h, a), 'core_restarted');
    assert.equal(state(h, d), 'delivered');
    assert.equal(state(h, w), 'withdrawn');
    await assert.rejects(waitForDecision(h, { sessionId: 'S1', requestId: a, waitMs: 0 }), (e: unknown) => (e as { code?: string }).code === 'gone');
    assert.equal(h.audit.records.findLast((r) => r.event === 'closed')?.settledBy, 'core_restart');
  });
});

describe('listRequests (#618/AC-7)', () => {
  test('#618/AC-7: it lists the pending and the recently closed in the shape the /ui reads, redacted, with no tool input', async () => {
    const h = harness();
    const id = await register(h, { toolInput: { command: 'DATABASE_URL=postgres://u:hunter2pw@h/db npm run migrate' } });
    const listing = listRequests(h, { sessionId: 'S1', unavailableReason: null });
    assert.deepEqual(listing, {
      available: true,
      reason: null,
      requests: [
        {
          id,
          state: 'pending',
          tool: 'Bash',
          summary: h.repository.find('S1', id)?.summary,
          folder: '/w',
          requestedAt: new Date(T0).toISOString(),
          expiresAt: new Date(T0 + 570_000).toISOString(),
          terminalOnly: true,
          decision: null,
          reason: null,
        },
      ],
    });
    assert.doesNotMatch(JSON.stringify(listing), /hunter2pw/);
  });

  test('#618/AC-7: an answered request shows its decision and reason; only this session is listed', async () => {
    const h = harness();
    const id = await register(h);
    await register(h, { sessionId: 'S2' });
    answerRequest(h, { sessionId: 'S1', requestId: id, decision: 'deny', reason: 'later', answeredBy: 'owner', channel: 'ui' });
    const { requests } = listRequests(h, { sessionId: 'S1', unavailableReason: null });
    assert.equal(requests.length, 1);
    assert.deepEqual([requests[0]?.state, requests[0]?.decision, requests[0]?.reason], ['answered', 'deny', 'later']);
  });

  test('#618/AC-7: a request closed over 10 minutes ago is dropped; a pending one stays; the order is oldest first', async () => {
    const h = harness();
    const old = await register(h);
    withdrawRequest(h, { sessionId: 'S1', requestId: old });
    await h.clock.advance(RECENT_MS - 1);
    const fresh = await register(h);
    assert.deepEqual(listRequests(h, { sessionId: 'S1', unavailableReason: null }).requests.map((r) => r.id), [old, fresh]);
    await h.clock.advance(2);
    assert.deepEqual(listRequests(h, { sessionId: 'S1', unavailableReason: null }).requests.map((r) => r.id), [fresh]);
  });

  test('#618/AC-7: a request past its deadline reads as expired', async () => {
    const h = harness();
    const id = await register(h);
    await h.clock.advance(9 * 60_000 + 30_000);
    const { requests } = listRequests(h, { sessionId: 'S1', unavailableReason: null });
    assert.equal(requests[0]?.id, id);
    assert.equal(requests[0]?.state, 'expired');
  });

  test('#618/AC-7: an unavailable capability says why and lists nothing', async () => {
    const h = harness();
    await register(h);
    assert.deepEqual(listRequests(h, { sessionId: 'S1', unavailableReason: 'off' }), { available: false, reason: 'off', requests: [] });
  });
});
