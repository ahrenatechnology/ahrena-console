// GET /api/historico (#33, C15) em 127.0.0.1: a página por dias, o cursor, a busca, o 400 de cada
// parâmetro e o núcleo sem o histórico. Dados do simulador (P4), com o fuso fixo em UTC.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Contas, MontadorDoPainel, iniciarApiLocal } from '../../src/api/index.ts';
import { SqliteDecisionStore } from '../../src/decisoes/sqlite.ts';
import { HistoricoDeSessoes, type RespostaDoHistorico } from '../../src/historico/leitura.ts';
import { ANTES_DO_CLEAR, DEPOIS_DO_CLEAR, semearHistoricoDoPainel } from '../../src/simulador/historico-encerradas.ts';
import { SESSAO_DO_PAINEL, semearCenariosDoPainel, semearDecisoesDoPainel } from '../../src/simulador/painel.ts';
import { T0 } from '../fixtures.ts';

const AGORA = Date.parse(T0);

async function subir(comHistorico = true) {
  const storage = openSqliteStorage({ path: ':memory:' });
  const decisoes = new SqliteDecisionStore(storage.db);
  await semearCenariosDoPainel(storage, 'p4', AGORA);
  await semearDecisoesDoPainel(decisoes, 'p4', AGORA);
  await semearHistoricoDoPainel(storage, decisoes, 'p4', AGORA);
  const montador = new MontadorDoPainel({ storage, contas: new Contas({ storage, arquivo: null }), desktop: null, trabalho: null, decisoes, agora: () => AGORA, apelido: () => SESSAO_DO_PAINEL });
  const historico = comHistorico ? new HistoricoDeSessoes({ storage, decisoes, fusoHorario: 'UTC' }) : undefined;
  const api = await iniciarApiLocal({ montador, hooks: { storage }, port: 0, log: () => {}, historico });
  return {
    get: (q = '') => fetch(`${api.url}/api/historico${q}`),
    fechar: async () => {
      await api.close();
      await storage.close();
    },
  };
}

describe('GET /api/historico', () => {
  test('a primeira página: 7 dias com sessão encerrada, o item completo e o cursor', async () => {
    const { get, fechar } = await subir();
    try {
      const r = await get();
      assert.equal(r.status, 200);
      const corpo = (await r.json()) as RespostaDoHistorico;
      assert.deepEqual(Object.keys(corpo).sort(), ['dias', 'proximo']);
      assert.equal(corpo.dias.length, 7);
      assert.equal(corpo.dias[0].dia, '2026-11-02');
      assert.equal(corpo.proximo, '2026-10-25');
      const depois = corpo.dias[1].sessoes[0];
      assert.deepEqual(Object.keys(depois).sort(), ['anterior', 'custoUsd', 'duracaoMs', 'fim', 'id', 'inicio', 'modelo', 'projeto', 'seguinte', 'status', 'titulo']);
      assert.equal(depois.id, DEPOIS_DO_CLEAR);
      assert.deepEqual(depois.anterior, { id: ANTES_DO_CLEAR, titulo: 'Mapear o módulo de pagamentos' });
      assert.equal(depois.modelo, 'Opus 5.5');
    } finally {
      await fechar();
    }
  });

  test('o `proximo` como `antes` traz o resto, sem repetir dia; `dias` muda o tamanho da página', async () => {
    const { get, fechar } = await subir();
    try {
      const vistos: string[] = [];
      let antes: string | null = null;
      for (let i = 0; i < 10; i++) {
        const corpo = (await (await get(`?dias=3${antes ? `&antes=${antes}` : ''}`)).json()) as RespostaDoHistorico;
        assert.ok(corpo.dias.length <= 3);
        vistos.push(...corpo.dias.map((d) => d.dia));
        antes = corpo.proximo;
        if (!antes) break;
      }
      assert.deepEqual(vistos, ['2026-11-02', '2026-11-01', '2026-10-31', '2026-10-30', '2026-10-28', '2026-10-27', '2026-10-25', '2026-10-24']);
    } finally {
      await fechar();
    }
  });

  test('a busca, sem diferenciar maiúsculas', async () => {
    const { get, fechar } = await subir();
    try {
      const corpo = (await (await get('?busca=Gateway')).json()) as RespostaDoHistorico;
      assert.deepEqual(corpo.dias.map((d) => [d.dia, d.sessoes.map((s) => s.id)]), [['2026-10-24', ['sim-historico-limites-do-gateway']]]);
      assert.equal(corpo.proximo, null);
    } finally {
      await fechar();
    }
  });

  test('parâmetro inválido dá 400 com o erro', async () => {
    const { get, fechar } = await subir();
    try {
      for (const q of ['?antes=ontem', '?antes=2026-13-01', '?dias=0', '?dias=32', '?dias=dez', `?busca=${'a'.repeat(101)}`]) {
        const r = await get(q);
        assert.equal(r.status, 400, q);
        assert.match(((await r.json()) as { error: string }).error, /antes|dias|busca/, q);
      }
    } finally {
      await fechar();
    }
  });

  test('sem o histórico ligado, 404', async () => {
    const { get, fechar } = await subir(false);
    try {
      assert.equal((await get()).status, 404);
    } finally {
      await fechar();
    }
  });
});
