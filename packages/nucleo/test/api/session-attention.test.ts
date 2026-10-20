// #245: the English attention of a session (`blocked` or `idle`, with one of the eight reasons), the
// one shape every /ui route answers. Derived from `atencaoDe` (#140) only, so every surface counts alike.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { eventAttention, readSessionAttention, sessionAttention, SESSION_ATTENTION_REASONS, BLOCKED_REASONS, IDLE_REASONS } from '../../src/api/attention.ts';
import { aplicarEvento, resumoVazio, type ResumoDosEventos } from '../../src/api/summary.ts';
import type { InboxReading } from '../../src/states/inbox.ts';
import { at, event, session as fixtureSession } from '../fixtures.ts';
import type { Session } from '../../src/model.ts';

const S = 'sess-attention';
const ev = (minute: number, type: string, toolName: string | null, data: Record<string, unknown> = {}, summary: string | null = null) =>
  event({ sessionId: S, agentId: null, type, toolName, createdAt: at(minute), data, summary });
const summaryOf = (...events: ReturnType<typeof ev>[]): ResumoDosEventos => {
  const r = resumoVazio();
  for (const e of events) aplicarEvento(r, e);
  return r;
};
const inbox = (over: Partial<InboxReading>): InboxReading => ({
  status: 'waiting',
  state: 'waiting',
  reason: 'stop',
  urgent: false,
  needsYou: true,
  activeSubagents: 0,
  backgroundProcesses: 0,
  ...over,
});

describe('#245/AC-4 blocked: the session is stuck until you act, with the reason', () => {
  test('permission, question, plan, decision and error are blocked', () => {
    assert.deepEqual(sessionAttention(inbox({ reason: 'notification' }), summaryOf(ev(1, 'Notification', null, { notification_type: 'permission_prompt' }))), { level: 'blocked', reason: 'permission' });
    assert.deepEqual(sessionAttention(inbox({ reason: 'notification' }), summaryOf(ev(1, 'Notification', null, { notification_type: 'elicitation_dialog' }))), { level: 'blocked', reason: 'question' });
    const plan = summaryOf(ev(1, 'ToolUse', 'ExitPlanMode', { toolUseId: 't2', tool_input: { plan: '# Plan' } }));
    assert.deepEqual(sessionAttention(inbox({ reason: 'stop' }), plan), { level: 'blocked', reason: 'plan' });
    const decision = summaryOf(ev(1, 'PreToolUse', 'mcp__ccd_turn__wrap_up', { tool_use_id: 'w1', tool_input: { recap: 'done', ask: 'Merge?' } }));
    assert.deepEqual(sessionAttention(inbox({ reason: 'stop' }), decision), { level: 'blocked', reason: 'decision' });
    assert.deepEqual(sessionAttention(inbox({ status: 'error', state: 'error', reason: null }), null), { level: 'blocked', reason: 'error' });
  });
});

describe('#245/AC-3 idle: the turn ended and nothing blocks', () => {
  test('the turn that ended, Esc and a new session at the prompt are idle', () => {
    assert.deepEqual(sessionAttention(inbox({ reason: 'stop' }), summaryOf()), { level: 'idle', reason: 'turn_ended' });
    assert.deepEqual(sessionAttention(inbox({ reason: 'interrupted' }), summaryOf()), { level: 'idle', reason: 'interrupted' });
    assert.deepEqual(sessionAttention(inbox({ reason: 'session_start' }), summaryOf()), { level: 'idle', reason: 'first_prompt' });
  });

  test('a session that is not waiting on you and not in error has no attention', () => {
    for (const state of ['active', 'delegating', 'background', 'completed', 'abandoned'] as const) {
      assert.equal(sessionAttention(inbox({ status: state === 'delegating' || state === 'background' ? 'waiting' : state, state, needsYou: false }), summaryOf()), null, state);
    }
  });

  test('the eight reasons split five blocked and three idle', () => {
    assert.deepEqual([...BLOCKED_REASONS], ['permission', 'question', 'plan', 'decision', 'error']);
    assert.deepEqual([...IDLE_REASONS], ['turn_ended', 'interrupted', 'first_prompt']);
    assert.deepEqual([...SESSION_ATTENTION_REASONS], [...BLOCKED_REASONS, ...IDLE_REASONS]);
  });
});

describe('#245 the attention of one event, for the feed', () => {
  test('a blocking request is blocked, the end of a turn is idle, an error is blocked, the rest has none', () => {
    const cases: [ReturnType<typeof ev>, unknown][] = [
      [ev(1, 'Notification', null, { notification_type: 'permission_prompt' }), { level: 'blocked', reason: 'permission' }],
      [ev(1, 'Notification', null, { notification_type: 'elicitation_dialog' }), { level: 'blocked', reason: 'question' }],
      [ev(1, 'Notification', null, {}, 'Claude needs your permission to use Bash'), { level: 'blocked', reason: 'permission' }],
      [ev(1, 'Notification', null, { notification_type: 'idle_prompt' }), { level: 'idle', reason: 'turn_ended' }],
      [ev(1, 'PermissionRequest', 'Bash'), { level: 'blocked', reason: 'permission' }],
      [ev(1, 'Stop', null), { level: 'idle', reason: 'turn_ended' }],
      [ev(1, 'Interrupted', null), { level: 'idle', reason: 'interrupted' }],
      [ev(1, 'APIError', null), { level: 'blocked', reason: 'error' }],
      [ev(1, 'StopFailure', null), { level: 'blocked', reason: 'error' }],
      [ev(1, 'PreToolUse', 'Bash'), null],
      [ev(1, 'SessionEnd', null), null],
    ];
    for (const [e, expected] of cases) assert.deepEqual(eventAttention(e), expected, `${e.type} ${JSON.stringify(e.data)}`);
  });
});

describe('#245 the attention of a stored session', () => {
  const session = (over: Partial<Session>): Session => fixtureSession({ id: S, updatedAt: at(5), ...over });

  test('an ended or working session reads no events; a waiting one reads its summary', async () => {
    const read: string[] = [];
    const summaries = {
      ler: async (id: string) => {
        read.push(id);
        return summaryOf(ev(1, 'Notification', null, { notification_type: 'permission_prompt' }));
      },
    };
    assert.equal(await readSessionAttention(session({ status: 'completed' }), [], summaries), null);
    assert.equal(await readSessionAttention(session({ status: 'active' }), [], summaries), null);
    assert.deepEqual(await readSessionAttention(session({ status: 'error', endedAt: at(4) }), [], summaries), { level: 'blocked', reason: 'error' });
    assert.deepEqual(read, []);
    assert.deepEqual(await readSessionAttention(session({ awaitingInputSince: at(4), awaitingReason: 'notification' }), [], summaries), { level: 'blocked', reason: 'permission' });
    assert.deepEqual(read, [S]);
  });
});
