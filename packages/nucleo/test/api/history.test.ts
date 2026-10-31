import { OWNER_TOKEN, ownerFetch as fetch } from '../owner-http.ts';
// GET /api/history (#33, C15) on 127.0.0.1: the page by days, the cursor, the search, the 400 of each
// parameter and the core with no history. Simulator data (P4), with the time zone fixed at UTC.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Accounts, MontadorDoPainel, startLocalApi } from '../../src/api/index.ts';
import { SqliteDecisionStore } from '../../src/decisions/sqlite.ts';
import { SessionHistory, type HistoryResponse } from '../../src/history/reading.ts';
import { BEFORE_CLEAR, AFTER_CLEAR, seedPanelHistory } from '../../src/simulator/history-ended.ts';
import { PANEL_SESSION, seedPanelScenario, seedPanelDecisions } from '../../src/simulator/panel.ts';
import { T0 } from '../fixtures.ts';

const AGORA = Date.parse(T0);

async function subir(comHistorico = true) {
  const storage = openSqliteStorage({ path: ':memory:' });
  const decisoes = new SqliteDecisionStore(storage.db);
  await seedPanelScenario(storage, 'p4', AGORA);
  await seedPanelDecisions(decisoes, 'p4', AGORA);
  await seedPanelHistory(storage, decisoes, 'p4', AGORA);
  const montador = new MontadorDoPainel({ storage, contas: new Accounts({ storage, file: null }), desktop: null, trabalho: null, decisoes, agora: () => AGORA, apelido: () => PANEL_SESSION });
  const historico = comHistorico ? new SessionHistory({ storage, decisions: decisoes, timeZone: 'UTC' }) : undefined;
  const api = await startLocalApi({ ownerToken: () => OWNER_TOKEN, panelBuilder: montador, hooks: { storage }, port: 0, log: () => {}, history: historico });
  return {
    get: (q = '') => fetch(`${api.url}/api/history${q}`),
    fechar: async () => {
      await api.close();
      await storage.close();
    },
  };
}

describe('GET /api/history', () => {
  test('a primeira página: 7 dias com sessão encerrada, o item completo e o cursor', async () => {
    const { get, fechar } = await subir();
    try {
      const r = await get();
      assert.equal(r.status, 200);
      const corpo = (await r.json()) as HistoryResponse;
      assert.deepEqual(Object.keys(corpo).sort(), ['days', 'next']);
      assert.equal(corpo.days.length, 7);
      assert.equal(corpo.days[0].day, '2026-11-02');
      assert.equal(corpo.next, '2026-10-25');
      const depois = corpo.days[1].sessions[0];
      assert.deepEqual(Object.keys(depois).sort(), ['costUsd', 'durationMs', 'end', 'id', 'model', 'next', 'previous', 'project', 'start', 'status', 'title']);
      assert.equal(depois.id, AFTER_CLEAR);
      assert.deepEqual(depois.previous, { id: BEFORE_CLEAR, title: 'Mapear o módulo de pagamentos' });
      assert.equal(depois.model, 'Opus 5.5');
    } finally {
      await fechar();
    }
  });

  test('o `next` como `before` traz o resto, sem repetir dia; `days` muda o tamanho da página', async () => {
    const { get, fechar } = await subir();
    try {
      const vistos: string[] = [];
      let antes: string | null = null;
      for (let i = 0; i < 10; i++) {
        const corpo = (await (await get(`?days=3${antes ? `&before=${antes}` : ''}`)).json()) as HistoryResponse;
        assert.ok(corpo.days.length <= 3);
        vistos.push(...corpo.days.map((d) => d.day));
        antes = corpo.next;
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
      const corpo = (await (await get('?search=Gateway')).json()) as HistoryResponse;
      assert.deepEqual(corpo.days.map((d) => [d.day, d.sessions.map((s) => s.id)]), [['2026-10-24', ['sim-history-gateway-limits']]]);
      assert.equal(corpo.next, null);
    } finally {
      await fechar();
    }
  });

  test('parâmetro inválido dá 400 com o erro', async () => {
    const { get, fechar } = await subir();
    try {
      for (const q of ['?before=ontem', '?before=2026-13-01', '?days=0', '?days=32', '?days=dez', `?search=${'a'.repeat(101)}`]) {
        const r = await get(q);
        assert.equal(r.status, 400, q);
        assert.match(((await r.json()) as { error: string }).error, /^(before|days|search): /, q);
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
