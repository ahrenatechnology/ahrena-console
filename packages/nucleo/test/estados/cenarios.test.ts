// Cenários do simulador (modo caos) passando pela máquina: só os eventos entram, e o estado
// que a máquina deriva tem de bater com o que o roteiro do simulador diz que aconteceu.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { lerInbox, transicionar, vigiar, type EstadoDaSessao } from '../../src/estados/index.ts';
import { displayStatus, type Session } from '../../src/model.ts';
import { gerarCenario, type Roteiro } from '../../src/simulador/index.ts';

const INICIO = Date.parse('2026-11-02T06:00:00.000Z');
const cenario = gerarCenario({ semente: 15, caos: true, sessoes: 16, relogio: (ms) => new Date(INICIO + ms).toISOString() });

interface Rodada {
  roteiro: Roteiro;
  final: Session;
  estado: EstadoDaSessao;
  passouPorDelegando: boolean;
}

function rodar(indice: number): Rodada {
  const ops = cenario.operacoes.filter((o) => o.sessao === indice);
  let estado: EstadoDaSessao | null = null;
  let final: Session | null = null;
  let passouPorDelegando = false;
  let ultimo = 0;
  for (const op of ops) {
    ultimo = op.deslocamentoMs;
    if (op.tipo === 'sessao') {
      final = op.registro;
      if (!estado) {
        // A máquina parte do registro mínimo, como o receptor cria; o resto ela deriva dos eventos.
        estado = { session: { ...op.registro, status: 'active', awaitingInputSince: null, awaitingReason: null, endedAt: null, metadata: {} }, agentes: [] };
      }
    } else if (op.tipo === 'agente' && estado) {
      // Agente novo chega como chegaria do transcript; o status é a máquina que decide.
      const atual: EstadoDaSessao = estado;
      const agente = op.registro;
      if (!atual.agentes.some((a) => a.id === agente.id)) {
        estado = { ...atual, agentes: [...atual.agentes, { ...agente, status: 'working', endedAt: null, currentTool: null }] };
      }
    } else if (op.tipo === 'evento' && estado) {
      estado = transicionar(estado, op.registro);
      if (lerInbox(estado.session, estado.agentes).estado === 'delegating') passouPorDelegando = true;
    }
  }
  assert.ok(estado && final);
  // Uma passada do vigia no fim da janela (sem sonda: os processos são de mentira).
  const vigilia = vigiar(estado, new Date(INICIO + ultimo), null);
  if (vigilia) estado = transicionar(estado, vigilia.evento);
  return { roteiro: cenario.roteiros[indice], final, estado, passouPorDelegando };
}

const rodadas = cenario.roteiros.map((_, i) => rodar(i));

describe('cenários do simulador', () => {
  // `erro`: o simulador grava error depois de um PostToolUseFailure; aqui falha de ferramenta não é erro da
  // sessão (o Claude segue). Erro vem de APIError, StopFailure ou Stop com stop_reason error.
  for (const roteiro of ['normal', 'travada', 'abandono', 'estouro', 'enxame'] as const) {
    test(`${roteiro}: o status derivado bate com o do roteiro`, () => {
      const daqui = rodadas.filter((r) => r.roteiro === roteiro);
      assert.ok(daqui.length > 0, `o cenário não tem ${roteiro}`);
      for (const r of daqui) {
        assert.equal(displayStatus(r.estado.session), displayStatus(r.final), `${r.final.id}`);
        assert.equal(r.estado.session.awaitingReason, r.final.awaitingReason, `${r.final.id}`);
      }
    });
  }

  test('enxame passa por "delegando" enquanto os subagentes rodam', () => {
    for (const r of rodadas.filter((x) => x.roteiro === 'enxame')) assert.equal(r.passouPorDelegando, true, r.final.id);
  });

  test('travada fica no inbox como urgente', () => {
    for (const r of rodadas.filter((x) => x.roteiro === 'travada')) {
      const l = lerInbox(r.estado.session, r.estado.agentes);
      assert.equal(l.precisaDeVoce, true);
      assert.equal(l.urgente, true);
    }
  });
});
