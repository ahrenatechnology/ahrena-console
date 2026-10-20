// A leitura do histórico (#33) sobre a porta, com o P4 do simulador: as encerradas por dia, o custo
// pelo cálculo do painel, o título das vizinhas pelo /clear e o núcleo sem as decisões.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { SqliteDecisionStore } from '../../src/decisoes/sqlite.ts';
import { HistoricoDeSessoes, type ItemDoHistorico } from '../../src/historico/leitura.ts';
import { ANTES_DO_CLEAR, DEPOIS_DO_CLEAR, semearHistoricoDoPainel } from '../../src/simulador/historico.ts';
import { semearCenariosDoPainel, semearDecisoesDoPainel } from '../../src/simulador/painel.ts';
import { T0 } from '../fixtures.ts';

const AGORA = Date.parse(T0);

async function p4(comDecisoes = true) {
  const storage = openSqliteStorage({ path: ':memory:' });
  const decisoes = comDecisoes ? new SqliteDecisionStore(storage.db) : null;
  await semearCenariosDoPainel(storage, 'p4', AGORA);
  if (decisoes) await semearDecisoesDoPainel(decisoes, 'p4', AGORA);
  await semearHistoricoDoPainel(storage, decisoes, 'p4', AGORA);
  return { storage, historico: new HistoricoDeSessoes({ storage, decisoes, fusoHorario: 'UTC' }) };
}

const item = (dias: { sessoes: ItemDoHistorico[] }[], id: string) => dias.flatMap((d) => d.sessoes).find((s) => s.id === id)!;

describe('histórico: leitura', () => {
  test('P4: só as encerradas, por dia, 7 dias por página e o cursor para o resto', async () => {
    const { storage, historico } = await p4();
    const p1 = await historico.pagina({ antes: null, dias: 7, busca: null });
    assert.deepEqual(p1.dias.map((d) => d.dia), ['2026-11-02', '2026-11-01', '2026-10-31', '2026-10-30', '2026-10-28', '2026-10-27', '2026-10-25']);
    assert.deepEqual(p1.dias[0].sessoes.map((s) => s.id), ['sim-painel-blog-estatico'], 'as ativas do cenário não entram');
    assert.deepEqual(p1.dias[1].sessoes.map((s) => s.id), [DEPOIS_DO_CLEAR, ANTES_DO_CLEAR]);
    assert.equal(p1.proximo, '2026-10-25');
    const p2 = await historico.pagina({ antes: p1.proximo, dias: 7, busca: null });
    assert.deepEqual(p2.dias.map((d) => d.dia), ['2026-10-24']);
    assert.equal(p2.proximo, null);
    await storage.close();
  });

  test('o item: nome do modelo, status final, duração, custo e as vizinhas pelo /clear com o título', async () => {
    const { storage, historico } = await p4();
    const { dias } = await historico.pagina({ antes: null, dias: 31, busca: null });
    const depois = item(dias, DEPOIS_DO_CLEAR);
    assert.equal(depois.titulo, 'Extrair a cobrança');
    assert.equal(depois.projeto, 'vitrine-demo');
    assert.equal(depois.modelo, 'Opus 5.5');
    assert.equal(depois.status, 'completed');
    assert.equal(depois.duracaoMs, 110 * 60_000);
    assert.ok(Math.abs(depois.custoUsd! - 1.3) < 0.01, `custo ${depois.custoUsd}`);
    assert.deepEqual(depois.anterior, { id: ANTES_DO_CLEAR, titulo: 'Mapear o módulo de pagamentos' });
    assert.equal(depois.seguinte, null);
    assert.deepEqual(item(dias, ANTES_DO_CLEAR).seguinte, { id: DEPOIS_DO_CLEAR, titulo: 'Extrair a cobrança' });
    assert.equal(item(dias, ANTES_DO_CLEAR).anterior, null);
    assert.equal(item(dias, 'sim-historico-relatorio-mensal').status, 'error');
    assert.equal(item(dias, 'sim-historico-regras-de-desconto').status, 'abandoned');
    assert.equal(item(dias, 'sim-historico-busca-de-receitas').custoUsd, null, 'sem uso, sem custo');
    await storage.close();
  });

  test('a busca filtra antes de paginar', async () => {
    const { storage, historico } = await p4();
    const p = await historico.pagina({ antes: null, dias: 7, busca: 'VITRINE' });
    assert.deepEqual(p.dias.map((d) => d.sessoes.map((s) => s.id)), [[DEPOIS_DO_CLEAR, ANTES_DO_CLEAR]]);
    assert.equal(p.proximo, null);
    await storage.close();
  });

  test('sem as decisões, funciona e as vizinhas vêm null', async () => {
    const { storage, historico } = await p4(false);
    const { dias } = await historico.pagina({ antes: null, dias: 31, busca: null });
    assert.equal(item(dias, DEPOIS_DO_CLEAR).anterior, null);
    assert.equal(item(dias, ANTES_DO_CLEAR).seguinte, null);
    await storage.close();
  });

  test('o título da sessão pode vir de fora (o índice do Desktop) e a busca o enxerga', async () => {
    const storage = openSqliteStorage({ path: ':memory:' });
    await semearHistoricoDoPainel(storage, null, 'p4', AGORA);
    const historico = new HistoricoDeSessoes({ storage, fusoHorario: 'UTC', tituloDe: (s) => (s.id === ANTES_DO_CLEAR ? 'Título do Desktop' : null) });
    const p = await historico.pagina({ antes: null, dias: 7, busca: 'desktop' });
    assert.deepEqual(p.dias.flatMap((d) => d.sessoes.map((s) => `${s.id} ${s.titulo}`)), [`${ANTES_DO_CLEAR} Título do Desktop`]);
    await storage.close();
  });

  test('nos outros cenários, o simulador não grava histórico', async () => {
    const storage = openSqliteStorage({ path: ':memory:' });
    await semearHistoricoDoPainel(storage, null, 'p1', AGORA);
    assert.equal((await storage.listSessions()).items.length, 0);
    await storage.close();
  });
});
