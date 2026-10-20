import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DEFAULT_LIMITS, transition, checkWatcherRules } from '../../src/states/index.ts';
import { at } from '../fixtures.ts';
import { state, ev, mainAgent, sub } from './helpers.ts';

const minute = (m: number) => new Date(at(m));
const seconds = (s: number) => new Date(Date.parse(at(0)) + s * 1000);
const LIVE = new Set(['/repo/app']);

describe('dead turn (120 s)', () => {
  test('main agent working, no tool, 120 s without a signal → Interrupted', () => {
    const v = checkWatcherRules(state(), seconds(120), LIVE);
    assert.equal(v?.rule, 'dead_turn');
    assert.equal(v?.event.type, 'Interrupted');
    assert.equal(v?.event.createdAt, seconds(120).toISOString());
    const after = transition(state(), v!.event);
    assert.equal(after.session.awaitingReason, 'interrupted');
  });

  test('119 s not yet', () => {
    assert.equal(checkWatcherRules(state(), seconds(119), LIVE), null);
  });

  test('with a tool running it is not a dead turn', () => {
    assert.equal(checkWatcherRules(state({}, [mainAgent({ currentTool: 'Bash' })]), minute(30), LIVE), null);
  });

  test('delegating is not a dead turn', () => {
    assert.equal(checkWatcherRules(state({}, [mainAgent(), sub('agent-7', { updatedAt: at(0) })]), minute(30), LIVE), null);
    const delegating = transition(state(), ev('PreToolUse', 0, { toolName: 'Agent', data: { tool_use_id: 'tu' } }));
    const noTool = { ...delegating, agents: delegating.agents.map((a) => ({ ...a, currentTool: null })) };
    assert.equal(checkWatcherRules(noTool, minute(30), LIVE), null);
  });

  test('already waiting does not fire again', () => {
    assert.equal(checkWatcherRules(state({ awaitingInputSince: at(0), awaitingReason: 'stop' }, [mainAgent({ status: 'waiting' })]), minute(30), LIVE), null);
  });

  test('recent subagent activity postpones the count', () => {
    const e = state({}, [mainAgent(), sub('agent-7', { status: 'completed', updatedAt: at(1) })]);
    assert.equal(checkWatcherRules(e, seconds(150), LIVE), null);
    assert.equal(checkWatcherRules(e, seconds(180), LIVE)?.rule, 'dead_turn');
  });

  test('the limit is configurable', () => {
    assert.equal(checkWatcherRules(state(), seconds(10), LIVE, { ...DEFAULT_LIMITS, deadTurnMs: 10_000 })?.rule, 'dead_turn');
  });
});

describe('abandonment (180 min)', () => {
  test('active idle for 180 min → Abandoned', () => {
    const e = state({ awaitingInputSince: at(0), awaitingReason: 'stop' }, [mainAgent({ status: 'waiting' })]);
    assert.equal(checkWatcherRules(e, minute(179), LIVE), null);
    const v = checkWatcherRules(e, minute(180), LIVE);
    assert.equal(v?.rule, 'abandonment');
    const after = transition(e, v!.event);
    assert.equal(after.session.status, 'abandoned');
    assert.equal(after.session.awaitingInputSince, null);
  });

  test('error does not become abandoned', () => {
    assert.equal(checkWatcherRules(state({ status: 'error' }), minute(500), LIVE), null);
  });
});

describe('process probe', () => {
  test('no process in the cwd → synthetic SessionEnd', () => {
    const v = checkWatcherRules(state({}, [mainAgent({ currentTool: 'Bash' })]), minute(1), new Set(['/other']));
    assert.equal(v?.rule, 'probe');
    assert.equal(v?.event.type, 'SessionEnd');
    assert.deepEqual(v?.event.data, { sintetico: true, reason: 'processo_encerrado' });
    assert.match(v!.event.id, /^estado:[0-9a-f]{32}$/);
    assert.equal(transition(state(), v!.event).session.status, 'completed');
  });

  test('also applies to a session in error, which stays error when it ends', () => {
    const v = checkWatcherRules(state({ status: 'error' }), minute(1), new Set());
    assert.equal(v?.rule, 'probe');
    const after = transition(state({ status: 'error' }), v!.event);
    assert.equal(after.session.status, 'error');
    assert.equal(after.session.endedAt, at(1));
  });

  test('respects the 30 s grace period', () => {
    assert.equal(checkWatcherRules(state({}, [mainAgent({ currentTool: 'Bash' })]), seconds(29), new Set()), null);
  });

  test('probe off (null) ends nothing', () => {
    assert.equal(checkWatcherRules(state({}, [mainAgent({ currentTool: 'Bash' })]), minute(60), null), null);
  });

  test('a session without cwd is not probed', () => {
    assert.equal(checkWatcherRules(state({ cwd: null }, [mainAgent({ currentTool: 'Bash' })]), minute(60), new Set()), null);
  });

  test('a trailing slash in the cwd does not get in the way', () => {
    assert.equal(checkWatcherRules(state({ cwd: '/repo/app/' }, [mainAgent({ currentTool: 'Bash' })]), minute(60), LIVE), null);
  });

  test('the probe comes before abandonment', () => {
    assert.equal(checkWatcherRules(state(), minute(400), new Set())?.rule, 'probe');
  });
});

test('an ended session is not watched', () => {
  assert.equal(checkWatcherRules(state({ status: 'completed', endedAt: at(0) }), minute(500), new Set()), null);
  assert.equal(checkWatcherRules(state({ status: 'abandoned', endedAt: at(0) }), minute(500), new Set()), null);
});
