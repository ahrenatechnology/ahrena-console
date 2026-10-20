// As partes puras do front de Workflows (#96, C14) e da aba Workflow do detalhe (#97, C7), rodadas no
// node contra as respostas da API com a demonstração do p4: o layout do grafo de agentes, a escala da
// linha do tempo, o grafo de orquestração, as KPIs, os formatos e o registro da tela e dos ícones.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Contas, startLocalApi, MontadorDoPainel, TrabalhoPorBranch, type LocalApi } from '../../src/api/index.ts';
import { UI_FOLDER } from '../../src/api/ui.ts';
import { SimulatorWorkSource, seedPanelScenario } from '../../src/simulator/panel.ts';
import { seedDemoWorkflows } from '../../src/simulator/workflows.ts';
import { T0 } from '../fixtures.ts';
// @ts-expect-error: módulos do navegador, em JavaScript puro
import { decimal, duration, modelName, percent, when, tokens } from '../../ui/screens/workflow-format.js';
// @ts-expect-error: idem
import { thickness, agentState, writtenKpis, orchestrationLayout, runMeta, workflowsRoute, hasActive } from '../../ui/screens/workflows.js';
// @ts-expect-error: idem
import { create, nodeDetail, timelineScale, graphLayout, nodeName, bandSegments } from '../../ui/screens/session-detail-workflow.js';
// @ts-expect-error: idem
import { findScreen, SCREENS } from '../../ui/screens.js';
// @ts-expect-error: idem
import { ICON_NAMES } from '../../ui/dom.js';

const AGORA = Date.parse(T0);

function pedir(url: string, caminho: string): Promise<any> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ hostname, port, path: caminho }, (res) => {
      let texto = '';
      res.setEncoding('utf8');
      res.on('data', (p: string) => (texto += p));
      res.on('end', () => resolve(JSON.parse(texto)));
    });
    req.on('error', reject);
    req.end();
  });
}

const curto = (id: string) => id.replace('sim-wf-payments:', '');

describe('front de Workflows contra a demonstração do p4', () => {
  let storage: SqliteStorage;
  let api: LocalApi;
  before(async () => {
    storage = openSqliteStorage({ path: ':memory:' });
    await seedPanelScenario(storage, 'p4', AGORA);
    await seedDemoWorkflows(storage, AGORA);
    const trabalho = new TrabalhoPorBranch({ fonte: new SimulatorWorkSource(), git: SimulatorWorkSource.git, agora: () => AGORA });
    const montador = new MontadorDoPainel({ storage, contas: new Contas({ storage, arquivo: null }), desktop: null, trabalho, agora: () => AGORA });
    api = await startLocalApi({ panelBuilder: montador, hooks: { storage }, port: 0, log: () => {} });
  });
  after(async () => {
    await api.close();
    await storage.close();
  });

  test('C7: o laço dev → review → ajustes vira colunas pelas dependências, com o ramo mais longo na linha do principal', async () => {
    const w = await pedir(api.url, '/api/sessions/sim-wf-payments/workflow');
    const { colunas, linhas, pos } = graphLayout(w.nodes, w.edges);
    const col = Object.fromEntries(Object.entries(pos).map(([id, p]: [string, any]) => [curto(id), p.coluna]));
    assert.deepEqual(col, { main: 0, ex1: 1, pl: 1, ex2: 1, d1: 2, r1: 3, d2: 4, r2: 5, tr: 5 });
    assert.equal(colunas, 6);
    const linha = (id: string) => pos[`sim-wf-payments:${id}`].linha;
    // O tronco (principal → Plan → dev → review → dev → review) numa linha só; os ramos fora dela.
    for (const id of ['pl', 'd1', 'r1', 'd2', 'r2']) assert.equal(linha(id), linha('main'), id);
    assert.ok(linha('ex2') < linha('main'), 'o segundo Explore sobe');
    assert.ok(linha('ex1') > linha('main'), 'o primeiro Explore desce');
    assert.ok(linha('tr') > linha('r2'), 'o test-runner desce do dev r2');
    assert.equal(linhas, 3);
    // Nenhum par de nós no mesmo lugar.
    const lugares = Object.values(pos).map((p: any) => `${p.coluna}:${p.linha}`);
    assert.equal(new Set(lugares).size, lugares.length);
  });

  test('C7: o nó mostra a rodada, os ajustes pedidos no review, e tarefa · tempo nos outros', async () => {
    const w = await pedir(api.url, '/api/sessions/sim-wf-payments/workflow');
    const no = (id: string) => w.nodes.find((n: any) => n.id === `sim-wf-payments:${id}`);
    assert.equal(nodeName(no('d1')), 'dev · r1');
    assert.equal(nodeName(no('ex2')), 'Explore');
    assert.deepEqual(nodeDetail(no('r1')), { texto: '3 ajustes pedidos', ajustes: true });
    assert.deepEqual(nodeDetail(no('d2')), { texto: 'corrige · 7 min', ajustes: false });
    assert.match(nodeDetail(no('main')).texto, /^Opus 5\.5 · \d+ min$/);
    assert.deepEqual(nodeDetail({ name: 'review', round: 1, task: 'x', model: null, durationMs: 60_000, changesRequested: 1 }), { texto: '1 ajuste pedido', ajustes: true });
    // A aresta "ajustes" é própria, e a legenda conta as rodadas e os ajustes.
    assert.ok(w.edges.some((a: any) => a.type === 'changes-requested' && curto(a.from) === 'r1' && curto(a.to) === 'd2'));
    assert.equal(w.reviewRounds, 2);
    assert.equal(w.changesRequested, 3);
  });

  test('C7: uma faixa por agente, na escala da sessão; o trecho aberto vai até o fim', async () => {
    const w = await pedir(api.url, '/api/sessions/sim-wf-payments/workflow');
    const escala = timelineScale(w.timeline);
    assert.equal(escala.marcas.length, 5);
    assert.equal(escala.marcas[0], '0');
    for (const m of escala.marcas.slice(1)) assert.match(m, /^\d+ min$/);
    assert.equal(escala.resumo, `0 a ${escala.marcas[4].replace(' min', '')} min`);
    const principal = bandSegments(w.timeline.lanes[0], escala);
    assert.deepEqual(principal, [{ x: 0, largura: 100, state: 'active' }]);
    const explore = w.timeline.lanes.find((f: any) => f.label === 'Explore');
    const [primeiro, segundo] = bandSegments(explore, escala);
    assert.equal(primeiro.state, 'completed');
    assert.equal(segundo.state, 'active');
    assert.ok(primeiro.x < segundo.x && Math.abs(segundo.x + segundo.largura - 100) < 0.02);
  });

  test('C14: o grafo de orquestração põe todo nó na sua coluna e engrossa a aresta pelo volume', async () => {
    const d = await pedir(api.url, '/api/workflows?filter=all');
    const g = orchestrationLayout(d.graph, 960);
    assert.deepEqual(g.columns.map((c: any) => c.label), ['Origem', 'Agente principal', 'Tipos de subagente', 'Compactação', 'Resultado']);
    assert.equal(g.nodes.length, d.graph.nodes.length);
    const xDaColuna = new Map(d.graph.columns.map((c: any, i: number) => [c.id, i]));
    for (const n of g.nodes) assert.ok(n.y >= 0 && n.y + g.no.altura <= g.altura, n.id);
    // Colunas da esquerda para a direita, na ordem da API.
    const xs = [...new Set(g.nodes.sort((a: any, b: any) => (xDaColuna.get(a.column) as number) - (xDaColuna.get(b.column) as number)).map((n: any) => n.x))];
    assert.deepEqual(xs, [...xs].sort((a: any, b: any) => a - b));
    const maior = Math.max(...g.edges.map((a: any) => a.volume));
    for (const a of g.edges) {
      assert.match(a.d, /^M[\d.]+,[\d.]+ C/);
      assert.equal(a.espessura, thickness(a.volume, maior));
    }
    assert.equal(Math.max(...g.edges.map((a: any) => a.espessura)), 22);
    assert.ok(g.edges.filter((a: any) => a.erro).every((a: any) => a.to === 'outcome:error'));
    // Na janela de 1100 px o painel tem ~800 px: as 5 colunas dividem a largura e nada passa dela.
    for (const largura of [802, 1100, 640]) {
      const h = orchestrationLayout(d.graph, largura);
      assert.equal(h.largura, largura);
      assert.ok(h.no.largura >= 104 && h.no.largura <= 152, `nó com ${h.no.largura} px`);
      for (const n of h.nodes) {
        assert.ok(n.x >= 0 && n.x + h.no.largura <= largura, `${n.id} sai de ${largura} px`);
        assert.ok((n.texto.length + n.volumeEscrito.length) * 5.8 + 22 <= h.no.largura + 6, `${n.id}: "${n.texto}" não cabe`);
      }
    }
    // Em 1100 px os rótulos cabem inteiros; mais estreito, encolhem com reticências.
    assert.ok(orchestrationLayout(d.graph, 787).nodes.every((n: any) => n.texto === n.label));
    const estreito = orchestrationLayout(d.graph, 640).nodes.find((n: any) => n.id === 'compaction:none');
    assert.match(estreito.texto, /…$/);
    assert.equal(estreito.label, 'Sem compactação');
    assert.equal(thickness(0, 10), 1.2);
    assert.equal(thickness(5, 0), 1.2);
  });

  test('C14: KPIs, a linha do run, o estado dos agentes e quando reler', async () => {
    const d = await pedir(api.url, '/api/workflows?filter=all');
    const k = writtenKpis(d.kpis);
    assert.deepEqual(k.map((x: any) => x.rotulo), ['Profundidade', 'Subagentes', 'Sucesso', 'Fluxo comum', 'Rodadas', 'Duração']);
    assert.deepEqual(k.map((x: any) => x.sub).filter((s: string) => !s.includes('%')), ['níveis de agente', 'por sessão', 'dos subagentes', 'de review por PR', 'média']);
    assert.equal(k[3].valor, 'dev → review');
    assert.match(k[3].sub, /^\d+% das sessões$/);
    assert.match(k[2].valor, /^\d+%$/);
    const vazias = writtenKpis({ averageDepth: null, subagentsPerSession: null, subagentSuccess: null, commonFlow: null, roundsPerPr: null, averageDurationMs: null });
    assert.deepEqual(vazias.map((x: any) => x.valor), ['—', '—', '—', '—', '—', '—']);

    const run = d.runs.find((r: any) => r.name === 'dev-review');
    assert.match(runMeta(run), /^motor-de-regras · 5 agentes · 36 ferramentas · 223 k tokens · \d+ min$/);
    const feito = d.runs.find((r: any) => r.name === 'triagem-de-bugs');
    assert.equal(runMeta(feito, new Date(AGORA)), 'vitrine-demo · 4 agentes · 22 ferramentas · 140 k tokens · 12 min · ontem');
    assert.deepEqual(run.agents.map((a: any) => agentState(a)[0]), ['Concluído', '3 ajustes', 'Concluído', 'Rodando', 'Rodando']);
    assert.deepEqual(agentState({ state: 'error' }), ['Erro', 'error']);
    assert.deepEqual(agentState({ state: 'changes-requested', changesRequested: null }), ['Ajustes', 'error']);
    assert.ok(hasActive(d));
    assert.equal(hasActive(await pedir(api.url, '/api/workflows?filter=completed')), false);
  });

  test('a aba lê `<base>/workflow`, para de reler ao esconder e não lê sem corpo', async () => {
    const lidas: string[] = [];
    const sair = new AbortController();
    const aba = create({ read: async (r: string) => (lidas.push(r), { nodes: [] }), signal: sair.signal }, '/api/sessions/x', { head: () => null, setLabel: () => {} });
    assert.deepEqual(Object.keys(aba).sort(), ['hide', 'refresh', 'show']);
    await aba.refresh();
    assert.deepEqual(lidas, [], 'escondida, não lê');
    sair.abort();
  });
});

describe('formatos e registro', () => {
  test('modelo, tokens, duração, porcentagem, decimal e quando', () => {
    assert.equal(modelName('claude-opus-5-5'), 'Opus 5.5');
    assert.equal(modelName('claude-sonnet-5-5'), 'Sonnet 5.5');
    assert.equal(modelName('claude-haiku-4-5-20251001'), 'Haiku 4.5');
    assert.equal(modelName('gpt-x'), 'gpt-x');
    assert.equal(modelName(null), null);
    assert.equal(tokens(223_000), '223 k');
    assert.equal(tokens(4_100), '4,1 k');
    assert.equal(tokens(812), '812');
    assert.equal(tokens(6_000_000), '6,0 M');
    assert.equal(duration(12_000), '12 s');
    assert.equal(duration(28 * 60_000), '28 min');
    assert.equal(duration(65 * 60_000), '1 h 05 min');
    assert.equal(duration(null), '—');
    assert.equal(percent(0.9444), '94%');
    assert.equal(decimal(1.666), '1,7');
    const agora = new Date(2026, 9, 20, 10);
    assert.equal(when(new Date(2026, 9, 20, 1).toISOString(), agora), 'hoje');
    assert.equal(when(new Date(2026, 9, 19, 23).toISOString(), agora), 'ontem');
    assert.equal(when(new Date(2026, 9, 18, 9).toISOString(), agora), 'há 2 dias');
  });

  test('escala curta: menos de 4 min fica com uma casa', () => {
    const e = timelineScale({ start: '2026-10-20T10:00:00.000Z', end: '2026-10-20T10:02:00.000Z' });
    assert.deepEqual(e.marcas, ['0', '0,5 min', '1 min', '1,5 min', '2 min']);
    assert.equal(e.fracao('2026-10-20T10:01:00.000Z'), 0.5);
    assert.equal(e.fracao(null), 1);
  });

  test('layout sobrevive a ciclo e a nó solto', () => {
    const nos = ['a', 'b', 'c', 'solto'].map((id) => ({ id }));
    const { pos } = graphLayout(nos, [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'b' }, { from: 'x', to: 'a' }]);
    assert.deepEqual(Object.keys(pos).sort(), ['a', 'b', 'c', 'solto']);
    assert.equal(pos.a.coluna, 0);
  });

  test('a rota leva o filtro e o nó', () => {
    assert.equal(workflowsRoute('all', null), '/api/workflows?filter=all');
    assert.equal(workflowsRoute('active', 'subagent:code-reviewer'), '/api/workflows?filter=active&node=subagent%3Acode-reviewer');
  });

  test('Workflows está na barra depois de Analytics, como no wireframe, e todo ícone usado existe', () => {
    const t = SCREENS.find((x: any) => x.id === 'workflows');
    assert.deepEqual(t, {
      id: 'workflows',
      route: '/ui/workflows',
      item: { label: 'Workflows', icon: 'workflows', section: 'main' },
      title: 'Workflows',
      sub: 'Como os agentes se orquestram: delegação, rodadas de review e resultado',
      icon: 'workflows',
      file: '/ui/screens/workflows.js',
    });
    const ids = SCREENS.map((x: any) => x.id);
    assert.equal(ids.indexOf('workflows'), ids.indexOf('analytics-tab') + 1);
    assert.equal(findScreen('/ui/workflows').screen.id, 'workflows');
    const usados = new Set<string>(['workflows', 'graph']);
    for (const a of ['workflows.js', 'session-detail-workflow.js']) {
      const texto = readFileSync(`${UI_FOLDER}screens/${a}`, 'utf8');
      for (const [, nome] of texto.matchAll(/icone\('([a-z-]+)'\)/g)) usados.add(nome!);
      for (const [, nome] of texto.matchAll(/icone: '([a-z-]+)'/g)) usados.add(nome!);
    }
    for (const nome of usados) assert.ok(ICON_NAMES.includes(nome), `falta o ícone ${nome}`);
    // Sem desenho repetido com outro nome: `graph` é o mesmo de `workflows`, por referência.
    const dom = readFileSync(`${UI_FOLDER}dom.js`, 'utf8');
    assert.match(dom, /ICONS\.graph = ICONS\.workflows;/);
    const desenhos = [...dom.matchAll(/^\s+'?([\w-]+)'?: '(<[^']*)',$/gm)];
    for (const nome of ['workflows', 'people', 'repeat', 'gantt']) {
      const meu = desenhos.find((m) => m[1] === nome)![2];
      assert.deepEqual(desenhos.filter((m) => m[2] === meu).map((m) => m[1]), [nome], `o desenho de ${nome} se repete`);
    }
  });
});
