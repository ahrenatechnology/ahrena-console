// Simulator scenarios (chaos mode) going through the machine: only the events go in, and the state
// the machine derives must match what the simulator's script says happened.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readInbox, transition, checkWatcherRules, type SessionState } from '../../src/states/index.ts';
import { displayStatus, type Session } from '../../src/model.ts';
import { gerarCenario, type Roteiro } from '../../src/simulador/index.ts';

const START = Date.parse('2026-11-02T06:00:00.000Z');
const scenario = gerarCenario({ semente: 15, caos: true, sessoes: 16, relogio: (ms) => new Date(START + ms).toISOString() });

interface Run {
  script: Roteiro;
  final: Session;
  state: SessionState;
  wentThroughDelegating: boolean;
}

function run(index: number): Run {
  const ops = scenario.operacoes.filter((o) => o.sessao === index);
  let state: SessionState | null = null;
  let final: Session | null = null;
  let wentThroughDelegating = false;
  let last = 0;
  for (const op of ops) {
    last = op.deslocamentoMs;
    if (op.tipo === 'sessao') {
      final = op.registro;
      if (!state) {
        // The machine starts from the minimal record, as the receiver creates it; it derives the rest from the events.
        state = { session: { ...op.registro, status: 'active', awaitingInputSince: null, awaitingReason: null, endedAt: null, metadata: {} }, agents: [] };
      }
    } else if (op.tipo === 'agente' && state) {
      // A new agent arrives as it would from the transcript; the machine decides the status.
      const current: SessionState = state;
      const agent = op.registro;
      if (!current.agents.some((a) => a.id === agent.id)) {
        state = { ...current, agents: [...current.agents, { ...agent, status: 'working', endedAt: null, currentTool: null }] };
      }
    } else if (op.tipo === 'evento' && state) {
      state = transition(state, op.registro);
      if (readInbox(state.session, state.agents).state === 'delegating') wentThroughDelegating = true;
    }
  }
  assert.ok(state && final);
  // One watcher pass at the end of the window (no probe: the processes are fake).
  const finding = checkWatcherRules(state, new Date(START + last), null);
  if (finding) state = transition(state, finding.event);
  return { script: scenario.roteiros[index], final, state, wentThroughDelegating };
}

const runs = scenario.roteiros.map((_, i) => run(i));

describe('simulator scenarios', () => {
  // `erro`: the simulator saves error after a PostToolUseFailure; here a tool failure is not a session
  // error (Claude carries on). Error comes from APIError, StopFailure or Stop with stop_reason error.
  for (const script of ['normal', 'travada', 'abandono', 'estouro', 'enxame'] as const) {
    test(`${script}: the derived status matches the script's`, () => {
      const these = runs.filter((r) => r.script === script);
      assert.ok(these.length > 0, `the scenario has no ${script}`);
      for (const r of these) {
        assert.equal(displayStatus(r.state.session), displayStatus(r.final), `${r.final.id}`);
        assert.equal(r.state.session.awaitingReason, r.final.awaitingReason, `${r.final.id}`);
      }
    });
  }

  test('enxame goes through "delegating" while the subagents run', () => {
    for (const r of runs.filter((x) => x.script === 'enxame')) assert.equal(r.wentThroughDelegating, true, r.final.id);
  });

  test('travada stays in the inbox as urgent', () => {
    for (const r of runs.filter((x) => x.script === 'travada')) {
      const reading = readInbox(r.state.session, r.state.agents);
      assert.equal(reading.needsYou, true);
      assert.equal(reading.urgent, true);
    }
  });
});
