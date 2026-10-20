// #96 e #97 pela API, contra a demonstração `--demo --cenario p4` (simulador/workflows.ts).
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Contas, iniciarApiLocal, MontadorDoPainel, TrabalhoPorBranch, type ApiLocal, type RespostaDosWorkflows, type WorkflowDaSessao } from '../../src/api/index.ts';
import { FonteDeTrabalhoDoSimulador, semearCenariosDoPainel } from '../../src/simulador/painel.ts';
import { SESSOES_DOS_WORKFLOWS, semearWorkflowsDoDemo } from '../../src/simulador/workflows.ts';
import { T0 } from '../fixtures.ts';

const AGORA = Date.parse(T0);

function pedir(url: string, caminho: string): Promise<{ status: number; corpo: any }> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ hostname, port, path: caminho }, (res) => {
      let texto = '';
      res.setEncoding('utf8');
      res.on('data', (p: string) => (texto += p));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, corpo: JSON.parse(texto) }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('Workflows na API, com a demonstração do p4', () => {
  let storage: SqliteStorage;
  let api: ApiLocal;
  let trabalho: TrabalhoPorBranch;
  before(async () => {
    storage = openSqliteStorage({ path: ':memory:' });
    await semearCenariosDoPainel(storage, 'p4', AGORA);
    await semearWorkflowsDoDemo(storage, AGORA);
    trabalho = new TrabalhoPorBranch({ fonte: new FonteDeTrabalhoDoSimulador(), git: FonteDeTrabalhoDoSimulador.git, agora: () => AGORA });
    const montador = new MontadorDoPainel({ storage, contas: new Contas({ storage, arquivo: null }), desktop: null, trabalho, agora: () => AGORA });
    api = await iniciarApiLocal({ montador, hooks: { storage }, port: 0, log: () => {} });
  });
  after(async () => {
    await api.close();
    await storage.close();
  });

  test('#97/AC-1 #97/AC-2 #97/AC-4 Dado a sessão do laço, quando abro a aba Workflow, vejo os agentes, a volta do review e as contas', async () => {
    const primeiro = await pedir(api.url, '/api/sessoes/sim-wf-pagamentos/workflow');
    assert.equal(primeiro.status, 200);
    await trabalho.esperar();
    const { corpo } = await pedir(api.url, '/api/sessoes/sim-wf-pagamentos/workflow');
    const w = corpo as WorkflowDaSessao;
    assert.deepEqual(
      w.nos.map((n) => `${n.nome}${n.rodada ? `·r${n.rodada}` : ''}:${n.estado}`),
      ['Principal:ativo', 'Explore:concluido', 'Plan:concluido', 'dev·r1:concluido', 'review·r1:concluido', 'dev·r2:concluido', 'review·r2:ativo', 'test-runner:ativo', 'Explore:ativo'],
    );
    assert.deepEqual(w.arestas.filter((e) => e.tipo !== 'abriu').map((e) => e.rotulo), ['plano', 'diff', 'ajustes', 'v2', null]);
    assert.equal(w.nos.find((n) => n.nome === 'review' && n.rodada === 1)!.ajustes, 3, 'lido da última mensagem do review');
    assert.deepEqual([w.rodadasDeReview, w.ajustes], [2, 3]);
    assert.equal(w.resumo, 'dev → review até aprovar · termina no PR #90');
    assert.equal(w.duracaoMs, 28 * 60_000);
  });

  test('#97/AC-3 Dado a sessão do laço, a linha do tempo vai do início dela até agora, uma faixa por agente', async () => {
    const { corpo } = await pedir(api.url, '/api/sessoes/sim-wf-pagamentos/workflow');
    const w = corpo as WorkflowDaSessao;
    assert.equal(w.linhaDoTempo.fim, T0);
    assert.deepEqual(w.linhaDoTempo.faixas.map((f) => [f.rotulo, f.trechos.length]), [
      ['Agente principal', 1], ['Explore', 2], ['Plan', 1], ['dev · r1', 1], ['review · r1', 1], ['dev · r2', 1], ['review · r2', 1], ['test-runner', 1],
    ]);
  });

  test('#97 Dado uma sessão que não existe, a aba recebe 404; um id estranho, 400', async () => {
    assert.equal((await pedir(api.url, '/api/sessoes/nao-existe/workflow')).status, 404);
    assert.equal((await pedir(api.url, '/api/sessoes/a%20b/workflow')).status, 400);
  });

  test('#96/AC-1 #96/AC-2 Dado a demonstração, a tela Workflows traz os KPIs e os três runs, o ativo primeiro', async () => {
    const { status, corpo } = await pedir(api.url, '/api/workflows');
    assert.equal(status, 200);
    const r = corpo as RespostaDosWorkflows;
    assert.equal(r.filtro, 'todas');
    assert.equal(r.no, null);
    for (const k of Object.keys(r.kpis) as (keyof typeof r.kpis)[]) assert.notEqual(r.kpis[k], null, `KPI ${k}`);
    assert.equal(r.kpis.fluxoComum!.rotulo, 'dev → review');
    assert.deepEqual(r.runs.map((x) => [x.nome, x.estado, x.projeto]), [
      ['dev-review', 'ativa', 'motor-de-regras'],
      ['triagem-de-bugs', 'concluida', 'vitrine-demo'],
      ['comparar-bibliotecas', 'concluida', 'gateway-sandbox'],
    ]);
    const dev = r.runs[0];
    assert.deepEqual(dev.fases.map((f) => f.nome), ['Implementar', 'Revisar', 'Corrigir', 'Testar']);
    assert.deepEqual(dev.agentes.map((a) => [a.rotulo, a.fase, a.estado, a.tokens, a.ferramentas]), [
      ['dev:r1', 'Implementar', 'concluido', 88_000, 14],
      ['review:r1', 'Revisar', 'ajustes', 41_000, 6],
      ['dev:r2', 'Corrigir', 'concluido', 52_000, 9],
      ['review:r2', 'Revisar', 'rodando', 30_000, 4],
      ['test', 'Testar', 'rodando', 12_000, 3],
    ]);
    assert.deepEqual([dev.agentes.length, dev.ferramentas, dev.tokens, dev.modelo], [5, 36, 223_000, 'claude-opus-5-5']);
  });

  test('#96/AC-3 #96/AC-4 Dado o grafo, o clique num nó e o filtro valem para a tela inteira', async () => {
    const todas = (await pedir(api.url, '/api/workflows')).corpo as RespostaDosWorkflows;
    const total = todas.sessoes;
    assert.ok(total >= SESSOES_DOS_WORKFLOWS.length);
    assert.deepEqual(todas.grafo.colunas.map((c) => c.id), ['origem', 'principal', 'subagente', 'compactacao', 'resultado']);
    for (const id of ['origem:prompt', 'origem:retomada', 'compactacao:sem', 'compactacao:compactou', 'resultado:concluida', 'resultado:erro']) {
      assert.ok(todas.grafo.nos.some((n) => n.id === id && n.volume > 0), id);
    }
    const ativas = (await pedir(api.url, '/api/workflows?filtro=ativas')).corpo as RespostaDosWorkflows;
    const concluidas = (await pedir(api.url, '/api/workflows?filtro=concluidas')).corpo as RespostaDosWorkflows;
    assert.equal(ativas.sessoes + concluidas.sessoes, total);
    assert.deepEqual(ativas.runs.map((x) => x.nome), ['dev-review']);
    const retomadas = (await pedir(api.url, '/api/workflows?no=origem:retomada')).corpo as RespostaDosWorkflows;
    assert.equal(retomadas.no, 'origem:retomada');
    assert.equal(retomadas.grafo.nos.find((n) => n.id === 'principal')!.volume, retomadas.sessoes);
    assert.deepEqual(retomadas.runs.map((x) => x.nome), ['triagem-de-bugs']);
    assert.equal((await pedir(api.url, '/api/workflows?filtro=x')).status, 400);
    assert.equal((await pedir(api.url, '/api/workflows?no=qualquer')).status, 400);
  });
});
