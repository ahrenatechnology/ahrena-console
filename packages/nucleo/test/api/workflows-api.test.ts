// #96 e #97 pela API, contra a demonstração `--demo --scenario p4` (simulator/workflows.ts).
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Accounts, startLocalApi, MontadorDoPainel, TrabalhoPorBranch, type LocalApi, type RespostaDosWorkflows, type WorkflowDaSessao } from '../../src/api/index.ts';
import { SimulatorWorkSource, seedPanelScenario } from '../../src/simulator/panel.ts';
import { lerSessoesDosWorkflows, MAXIMO_DE_SESSOES, montarWorkflows } from '../../src/api/workflows.ts';
import { WORKFLOW_SESSIONS, seedDemoWorkflows } from '../../src/simulator/workflows.ts';
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
  let api: LocalApi;
  let trabalho: TrabalhoPorBranch;
  before(async () => {
    storage = openSqliteStorage({ path: ':memory:' });
    await seedPanelScenario(storage, 'p4', AGORA);
    await seedDemoWorkflows(storage, AGORA);
    trabalho = new TrabalhoPorBranch({ fonte: new SimulatorWorkSource(), git: SimulatorWorkSource.git, agora: () => AGORA });
    const montador = new MontadorDoPainel({ storage, contas: new Accounts({ storage, file: null }), desktop: null, trabalho, agora: () => AGORA });
    api = await startLocalApi({ panelBuilder: montador, hooks: { storage }, port: 0, log: () => {} });
  });
  after(async () => {
    await api.close();
    await storage.close();
  });

  test('#97/AC-1 #97/AC-2 #97/AC-4 Dado a sessão do laço, quando abro a aba Workflow, vejo os agentes, a volta do review e as contas', async () => {
    const primeiro = await pedir(api.url, '/api/sessions/sim-wf-payments/workflow');
    assert.equal(primeiro.status, 200);
    await trabalho.esperar();
    const { corpo } = await pedir(api.url, '/api/sessions/sim-wf-payments/workflow');
    const w = corpo as WorkflowDaSessao;
    assert.deepEqual(
      w.nodes.map((n) => `${n.name}${n.round ? `·r${n.round}` : ''}:${n.state}`),
      ['Principal:active', 'Explore:completed', 'Plan:completed', 'dev·r1:completed', 'review·r1:completed', 'dev·r2:completed', 'review·r2:active', 'test-runner:active', 'Explore:active'],
    );
    assert.deepEqual(w.edges.filter((e) => e.type !== 'opened').map((e) => e.label), ['plano', 'diff', 'ajustes', 'v2', null]);
    assert.equal(w.nodes.find((n) => n.name === 'review' && n.round === 1)!.changesRequested, 3, 'lido da última mensagem do review');
    assert.deepEqual([w.reviewRounds, w.changesRequested], [2, 3]);
    assert.equal(w.summary, 'dev → review até aprovar · termina no PR #90');
    assert.equal(w.durationMs, 28 * 60_000);
    // The old Portuguese route is gone.
    assert.deepEqual(await pedir(api.url, '/api/sessoes/sim-wf-payments/workflow'), { status: 404, corpo: { error: 'não encontrado' } });
  });

  test('#97/AC-3 Dado a sessão do laço, a linha do tempo vai do início dela até agora, uma faixa por agente', async () => {
    const { corpo } = await pedir(api.url, '/api/sessions/sim-wf-payments/workflow');
    const w = corpo as WorkflowDaSessao;
    assert.equal(w.timeline.end, T0);
    assert.deepEqual(w.timeline.lanes.map((f) => [f.label, f.spans.length]), [
      ['Agente principal', 1], ['Explore', 2], ['Plan', 1], ['dev · r1', 1], ['review · r1', 1], ['dev · r2', 1], ['review · r2', 1], ['test-runner', 1],
    ]);
  });

  test('#97 Dado uma sessão que não existe, a aba recebe 404; um id estranho, 400', async () => {
    assert.equal((await pedir(api.url, '/api/sessions/nao-existe/workflow')).status, 404);
    assert.equal((await pedir(api.url, '/api/sessions/a%20b/workflow')).status, 400);
    const malformado = await pedir(api.url, '/api/sessions/%E0/workflow');
    assert.equal(malformado.status, 400, 'decodeURIComponent falha: 400, não 500');
    assert.equal(malformado.corpo.error, 'id de sessão inválido');
    assert.equal((await pedir(api.url, '/api/sessions/%E0%A4%A/workflow')).status, 400, 'escape malformado não é 500');
  });

  test('#96/AC-1 #96/AC-2 Dado a demonstração, a tela Workflows traz os KPIs e os três runs, o ativo primeiro', async () => {
    const { status, corpo } = await pedir(api.url, '/api/workflows');
    assert.equal(status, 200);
    const r = corpo as RespostaDosWorkflows;
    assert.equal(r.filter, 'all');
    assert.equal(r.node, null);
    assert.equal(r.truncated, false);
    assert.equal(r.max, MAXIMO_DE_SESSOES, 'o teto usado vai no JSON');
    for (const k of Object.keys(r.kpis) as (keyof typeof r.kpis)[]) assert.notEqual(r.kpis[k], null, `KPI ${k}`);
    assert.equal(r.kpis.commonFlow!.label, 'dev → review');
    assert.deepEqual(r.runs.map((x) => [x.name, x.state, x.project]), [
      ['dev-review', 'active', 'motor-de-regras'],
      ['triagem-de-bugs', 'completed', 'vitrine-demo'],
      ['comparar-bibliotecas', 'completed', 'gateway-sandbox'],
    ]);
    const dev = r.runs[0];
    assert.deepEqual(dev.phases.map((f) => f.name), ['Implementar', 'Revisar', 'Corrigir', 'Testar']);
    assert.deepEqual(dev.agents.map((a) => [a.label, a.phase, a.state, a.tokens, a.tools]), [
      ['dev:r1', 'Implementar', 'completed', 88_000, 14],
      ['review:r1', 'Revisar', 'changes-requested', 41_000, 6],
      ['dev:r2', 'Corrigir', 'completed', 52_000, 9],
      ['review:r2', 'Revisar', 'running', 30_000, 4],
      ['test', 'Testar', 'running', 12_000, 3],
    ]);
    assert.deepEqual([dev.agents.length, dev.tools, dev.tokens, dev.model], [5, 36, 223_000, 'claude-opus-5-5']);
  });

  test('#96/AC-3 #96/AC-4 Dado o grafo, o clique num nó e o filtro valem para a tela inteira', async () => {
    const todas = (await pedir(api.url, '/api/workflows')).corpo as RespostaDosWorkflows;
    const total = todas.sessions;
    assert.equal(todas.truncated, false);
    assert.ok(total >= WORKFLOW_SESSIONS.length);
    assert.deepEqual(todas.graph.columns.map((c) => c.id), ['origin', 'main', 'subagent', 'compaction', 'outcome']);
    for (const id of ['origin:prompt', 'origin:resume', 'compaction:none', 'compaction:compacted', 'outcome:completed', 'outcome:error']) {
      assert.ok(todas.graph.nodes.some((n) => n.id === id && n.volume > 0), id);
    }
    const ativas = (await pedir(api.url, '/api/workflows?filter=active')).corpo as RespostaDosWorkflows;
    const concluidas = (await pedir(api.url, '/api/workflows?filter=completed')).corpo as RespostaDosWorkflows;
    assert.equal(ativas.sessions + concluidas.sessions, total);
    assert.deepEqual(ativas.runs.map((x) => x.name), ['dev-review']);
    const retomadas = (await pedir(api.url, '/api/workflows?node=origin:resume')).corpo as RespostaDosWorkflows;
    assert.equal(retomadas.node, 'origin:resume');
    assert.equal(retomadas.graph.nodes.find((n) => n.id === 'main')!.volume, retomadas.sessions);
    assert.deepEqual(retomadas.runs.map((x) => x.name), ['triagem-de-bugs']);
    const filtroRuim = await pedir(api.url, '/api/workflows?filter=x');
    assert.deepEqual([filtroRuim.status, filtroRuim.corpo.error], [400, 'filter: all, active ou completed']);
    const noRuim = await pedir(api.url, '/api/workflows?node=qualquer');
    assert.deepEqual([noRuim.status, noRuim.corpo.error], [400, 'node: um id de nó do grafo (ex.: subagent:Explore)']);
  });

  test('#96 Dado os nomes e valores antigos da query, eles não valem mais: o nome é ignorado, o valor dá 400', async () => {
    const todas = (await pedir(api.url, '/api/workflows')).corpo;
    for (const antigo of ['/api/workflows?filtro=active', '/api/workflows?no=main']) {
      const { status, corpo } = await pedir(api.url, antigo);
      assert.equal(status, 200, antigo);
      assert.deepEqual({ ...corpo, generatedAt: null }, { ...todas, generatedAt: null }, antigo);
    }
    for (const antigo of ['/api/workflows?filter=ativas', '/api/workflows?filter=concluidas', '/api/workflows?filter=todas']) {
      assert.deepEqual(await pedir(api.url, antigo), { status: 400, corpo: { error: 'filter: all, active ou completed' } }, antigo);
    }
    for (const antigo of ['principal', 'origem:retomada', 'resultado:erro', 'compactacao:compactou', 'subagente:Explore']) {
      assert.equal((await pedir(api.url, `/api/workflows?node=${antigo}`)).status, 400, antigo);
    }
  });

  test('#96 Dado mais sessões que o teto, a leitura diz que cortou', async () => {
    const todas = await lerSessoesDosWorkflows(storage, 'all');
    assert.equal(todas.truncado, false);
    const n = todas.sessoes.length;
    assert.ok(n >= 3);
    const cortada = await lerSessoesDosWorkflows(storage, 'all', n - 1);
    assert.deepEqual([cortada.sessoes.length, cortada.truncado], [n - 1, true]);
    const exata = await lerSessoesDosWorkflows(storage, 'all', n);
    assert.deepEqual([exata.sessoes.length, exata.truncado], [n, false], 'o teto exato não corta');
    assert.deepEqual(
      (({ truncated, max }) => [truncated, max])(montarWorkflows(cortada.sessoes, { agora: AGORA, truncado: cortada.truncado, maximo: n - 1 })),
      [true, n - 1],
    );
  });
});
