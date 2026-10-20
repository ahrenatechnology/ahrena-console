// Simulator scenarios (chaos mode) going through the machine: only the events go in, and the state
// the machine derives must match what the simulator's script says happened.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readInbox, transition, checkWatcherRules, type SessionState } from '../../src/states/index.ts';
import { displayStatus, type Session } from '../../src/model.ts';
import { generateScenario, type Script } from '../../src/simulator/index.ts';

const START = Date.parse('2026-11-02T06:00:00.000Z');
const scenario = generateScenario({ seed: 15, chaos: true, sessions: 16, clock: (ms) => new Date(START + ms).toISOString() });

interface Run {
  script: Script;
  final: Session;
  state: SessionState;
  wentThroughDelegating: boolean;
}

function run(index: number): Run {
  const ops = scenario.operations.filter((o) => o.sessionIndex === index);
  let state: SessionState | null = null;
  let final: Session | null = null;
  let wentThroughDelegating = false;
  let last = 0;
  for (const op of ops) {
    last = op.offsetMs;
    if (op.kind === 'session') {
      final = op.record;
      if (!state) {
        // The machine starts from the minimal record, as the receiver creates it; it derives the rest from the events.
        state = { session: { ...op.record, status: 'active', awaitingInputSince: null, awaitingReason: null, endedAt: null, metadata: {} }, agents: [] };
      }
    } else if (op.kind === 'agent' && state) {
      // A new agent arrives as it would from the transcript; the machine decides the status.
      const current: SessionState = state;
      const agent = op.record;
      if (!current.agents.some((a) => a.id === agent.id)) {
        state = { ...current, agents: [...current.agents, { ...agent, status: 'working', endedAt: null, currentTool: null }] };
      }
    } else if (op.kind === 'event' && state) {
      state = transition(state, op.record);
      if (readInbox(state.session, state.agents).state === 'delegating') wentThroughDelegating = true;
    }
  }
  assert.ok(state && final);
  // One watcher pass at the end of the window (no probe: the processes are fake).
  const finding = checkWatcherRules(state, new Date(START + last), null);
  if (finding) state = transition(state, finding.event);
  return { script: scenario.scripts[index], final, state, wentThroughDelegating };
}

const runs = scenario.scripts.map((_, i) => run(i));

describe('simulator scenarios', () => {
  // `error`: the simulator saves error after a PostToolUseFailure; here a tool failure is not a session
  // error (Claude carries on). Error comes from APIError, StopFailure or Stop with stop_reason error.
  for (const script of ['normal', 'stuck', 'abandonment', 'overflow', 'swarm'] as const) {
    test(`${script}: the derived status matches the script's`, () => {
      const these = runs.filter((r) => r.script === script);
      assert.ok(these.length > 0, `the scenario has no ${script}`);
      for (const r of these) {
        assert.equal(displayStatus(r.state.session), displayStatus(r.final), `${r.final.id}`);
        assert.equal(r.state.session.awaitingReason, r.final.awaitingReason, `${r.final.id}`);
      }
    });
  }

  test('swarm goes through "delegating" while the subagents run', () => {
    for (const r of runs.filter((x) => x.script === 'swarm')) assert.equal(r.wentThroughDelegating, true, r.final.id);
  });

  test('stuck stays in the inbox as urgent', () => {
    for (const r of runs.filter((x) => x.script === 'stuck')) {
      const reading = readInbox(r.state.session, r.state.agents);
      assert.equal(reading.needsYou, true);
      assert.equal(reading.urgent, true);
    }
  });
});
