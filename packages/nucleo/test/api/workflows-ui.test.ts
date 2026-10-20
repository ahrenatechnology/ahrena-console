// As partes puras do front de Workflows (#96, C14) e da aba Workflow do detalhe (#97, C7), rodadas no
// node contra as respostas da API com a demonstração do p4: o layout do grafo de agentes, a escala da
// linha do tempo, o grafo de orquestração, as KPIs, os formatos e o registro da tela e dos ícones.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Contas, iniciarApiLocal, MontadorDoPainel, TrabalhoPorBranch, type ApiLocal } from '../../src/api/index.ts';
import { PASTA_DA_UI } from '../../src/api/ui.ts';
import { FonteDeTrabalhoDoSimulador, semearCenariosDoPainel } from '../../src/simulador/painel.ts';
import { semearWorkflowsDoDemo } from '../../src/simulador/workflows.ts';
import { T0 } from '../fixtures.ts';
// @ts-expect-error: módulos do navegador, em JavaScript puro
import { decimal, duracao, nomeDoModelo, porcento, quando, tokens } from '../../ui/telas/workflow-formato.js';
// @ts-expect-error: idem
import { espessura, estadoDoAgente, kpisEscritas, layoutDaOrquestracao, metaDoRun, rotaDosWorkflows, temAtivo } from '../../ui/telas/workflows.js';
// @ts-expect-error: idem
import { criar, detalheDoNo, escalaDaLinha, layoutDoGrafo, nomeDoNo, trechosDaFaixa } from '../../ui/telas/detalhe-workflow.js';
// @ts-expect-error: idem
import { acharTela, TELAS } from '../../ui/telas.js';
// @ts-expect-error: idem
import { NOMES_DOS_ICONES } from '../../ui/dom.js';

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

const curto = (id: string) => id.replace('sim-wf-pagamentos:', '');

describe('front de Workflows contra a demonstração do p4', () => {
  let storage: SqliteStorage;
  let api: ApiLocal;
  before(async () => {
    storage = openSqliteStorage({ path: ':memory:' });
    await semearCenariosDoPainel(storage, 'p4', AGORA);
    await semearWorkflowsDoDemo(storage, AGORA);
    const trabalho = new TrabalhoPorBranch({ fonte: new FonteDeTrabalhoDoSimulador(), git: FonteDeTrabalhoDoSimulador.git, agora: () => AGORA });
    const montador = new MontadorDoPainel({ storage, contas: new Contas({ storage, arquivo: null }), desktop: null, trabalho, agora: () => AGORA });
    api = await iniciarApiLocal({ montador, hooks: { storage }, port: 0, log: () => {} });
  });
  after(async () => {
    await api.close();
    await storage.close();
  });

  test('C7: o laço dev → review → ajustes vira colunas pelas dependências, com o ramo mais longo na linha do principal', async () => {
    const w = await pedir(api.url, '/api/sessoes/sim-wf-pagamentos/workflow');
    const { colunas, linhas, pos } = layoutDoGrafo(w.nos, w.arestas);
    const col = Object.fromEntries(Object.entries(pos).map(([id, p]: [string, any]) => [curto(id), p.coluna]));
    assert.deepEqual(col, { main: 0, ex1: 1, pl: 1, ex2: 1, d1: 2, r1: 3, d2: 4, r2: 5, tr: 5 });
    assert.equal(colunas, 6);
    const linha = (id: string) => pos[`sim-wf-pagamentos:${id}`].linha;
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
    const w = await pedir(api.url, '/api/sessoes/sim-wf-pagamentos/workflow');
    const no = (id: string) => w.nos.find((n: any) => n.id === `sim-wf-pagamentos:${id}`);
    assert.equal(nomeDoNo(no('d1')), 'dev · r1');
    assert.equal(nomeDoNo(no('ex2')), 'Explore');
    assert.deepEqual(detalheDoNo(no('r1')), { texto: '3 ajustes pedidos', ajustes: true });
    assert.deepEqual(detalheDoNo(no('d2')), { texto: 'corrige · 7 min', ajustes: false });
    assert.match(detalheDoNo(no('main')).texto, /^Opus 5\.5 · \d+ min$/);
    assert.deepEqual(detalheDoNo({ nome: 'review', rodada: 1, tarefa: 'x', modelo: null, duracaoMs: 60_000, ajustes: 1 }), { texto: '1 ajuste pedido', ajustes: true });
    // A aresta "ajustes" é própria, e a legenda conta as rodadas e os ajustes.
    assert.ok(w.arestas.some((a: any) => a.tipo === 'ajustes' && curto(a.de) === 'r1' && curto(a.para) === 'd2'));
    assert.equal(w.rodadasDeReview, 2);
    assert.equal(w.ajustes, 3);
  });

  test('C7: uma faixa por agente, na escala da sessão; o trecho aberto vai até o fim', async () => {
    const w = await pedir(api.url, '/api/sessoes/sim-wf-pagamentos/workflow');
    const escala = escalaDaLinha(w.linhaDoTempo);
    assert.equal(escala.marcas.length, 5);
    assert.equal(escala.marcas[0], '0');
    for (const m of escala.marcas.slice(1)) assert.match(m, /^\d+ min$/);
    assert.equal(escala.resumo, `0 a ${escala.marcas[4].replace(' min', '')} min`);
    const principal = trechosDaFaixa(w.linhaDoTempo.faixas[0], escala);
    assert.deepEqual(principal, [{ x: 0, largura: 100, estado: 'ativo' }]);
    const explore = w.linhaDoTempo.faixas.find((f: any) => f.rotulo === 'Explore');
    const [primeiro, segundo] = trechosDaFaixa(explore, escala);
    assert.equal(primeiro.estado, 'concluido');
    assert.equal(segundo.estado, 'ativo');
    assert.ok(primeiro.x < segundo.x && Math.abs(segundo.x + segundo.largura - 100) < 0.02);
  });

  test('C14: o grafo de orquestração põe todo nó na sua coluna e engrossa a aresta pelo volume', async () => {
    const d = await pedir(api.url, '/api/workflows?filtro=todas');
    const g = layoutDaOrquestracao(d.grafo, 960);
    assert.deepEqual(g.colunas.map((c: any) => c.rotulo), ['Origem', 'Agente principal', 'Tipos de subagente', 'Compactação', 'Resultado']);
    assert.equal(g.nos.length, d.grafo.nos.length);
    const xDaColuna = new Map(d.grafo.colunas.map((c: any, i: number) => [c.id, i]));
    for (const n of g.nos) assert.ok(n.y >= 0 && n.y + g.no.altura <= g.altura, n.id);
    // Colunas da esquerda para a direita, na ordem da API.
    const xs = [...new Set(g.nos.sort((a: any, b: any) => (xDaColuna.get(a.coluna) as number) - (xDaColuna.get(b.coluna) as number)).map((n: any) => n.x))];
    assert.deepEqual(xs, [...xs].sort((a: any, b: any) => a - b));
    const maior = Math.max(...g.arestas.map((a: any) => a.volume));
    for (const a of g.arestas) {
      assert.match(a.d, /^M[\d.]+,[\d.]+ C/);
      assert.equal(a.espessura, espessura(a.volume, maior));
    }
    assert.equal(Math.max(...g.arestas.map((a: any) => a.espessura)), 22);
    assert.ok(g.arestas.filter((a: any) => a.erro).every((a: any) => a.para === 'resultado:erro'));
    // Na janela de 1100 px o painel tem ~800 px: as 5 colunas dividem a largura e nada passa dela.
    for (const largura of [802, 1100, 640]) {
      const h = layoutDaOrquestracao(d.grafo, largura);
      assert.equal(h.largura, largura);
      assert.ok(h.no.largura >= 104 && h.no.largura <= 152, `nó com ${h.no.largura} px`);
      for (const n of h.nos) {
        assert.ok(n.x >= 0 && n.x + h.no.largura <= largura, `${n.id} sai de ${largura} px`);
        assert.ok((n.texto.length + n.volumeEscrito.length) * 5.8 + 22 <= h.no.largura + 6, `${n.id}: "${n.texto}" não cabe`);
      }
    }
    // Em 1100 px os rótulos cabem inteiros; mais estreito, encolhem com reticências.
    assert.ok(layoutDaOrquestracao(d.grafo, 787).nos.every((n: any) => n.texto === n.rotulo));
    const estreito = layoutDaOrquestracao(d.grafo, 640).nos.find((n: any) => n.id === 'compactacao:sem');
    assert.match(estreito.texto, /…$/);
    assert.equal(estreito.rotulo, 'Sem compactação');
    assert.equal(espessura(0, 10), 1.2);
    assert.equal(espessura(5, 0), 1.2);
  });

  test('C14: KPIs, a linha do run, o estado dos agentes e quando reler', async () => {
    const d = await pedir(api.url, '/api/workflows?filtro=todas');
    const k = kpisEscritas(d.kpis);
    assert.deepEqual(k.map((x: any) => x.rotulo), ['Profundidade', 'Subagentes', 'Sucesso', 'Fluxo comum', 'Rodadas', 'Duração']);
    assert.deepEqual(k.map((x: any) => x.sub).filter((s: string) => !s.includes('%')), ['níveis de agente', 'por sessão', 'dos subagentes', 'de review por PR', 'média']);
    assert.equal(k[3].valor, 'dev → review');
    assert.match(k[3].sub, /^\d+% das sessões$/);
    assert.match(k[2].valor, /^\d+%$/);
    const vazias = kpisEscritas({ profundidadeMedia: null, subagentesPorSessao: null, sucessoSubagentes: null, fluxoComum: null, rodadasPorPr: null, duracaoMediaMs: null });
    assert.deepEqual(vazias.map((x: any) => x.valor), ['—', '—', '—', '—', '—', '—']);

    const run = d.runs.find((r: any) => r.nome === 'dev-review');
    assert.match(metaDoRun(run), /^motor-de-regras · 5 agentes · 36 ferramentas · 223 k tokens · \d+ min$/);
    const feito = d.runs.find((r: any) => r.nome === 'triagem-de-bugs');
    assert.equal(metaDoRun(feito, new Date(AGORA)), 'vitrine-demo · 4 agentes · 22 ferramentas · 140 k tokens · 12 min · ontem');
    assert.deepEqual(run.agentes.map((a: any) => estadoDoAgente(a)[0]), ['Concluído', '3 ajustes', 'Concluído', 'Rodando', 'Rodando']);
    assert.deepEqual(estadoDoAgente({ estado: 'erro' }), ['Erro', 'error']);
    assert.ok(temAtivo(d));
    assert.equal(temAtivo(await pedir(api.url, '/api/workflows?filtro=concluidas')), false);
  });

  test('a aba lê `<base>/workflow`, para de reler ao esconder e não lê sem corpo', async () => {
    const lidas: string[] = [];
    const sair = new AbortController();
    const aba = criar({ ler: async (r: string) => (lidas.push(r), { nos: [] }), sinal: sair.signal }, '/api/sessoes/x', { cabeca: () => null, rotular: () => {} });
    assert.deepEqual(Object.keys(aba).sort(), ['atualizar', 'esconder', 'mostrar']);
    await aba.atualizar();
    assert.deepEqual(lidas, [], 'escondida, não lê');
    sair.abort();
  });
});

describe('formatos e registro', () => {
  test('modelo, tokens, duração, porcentagem, decimal e quando', () => {
    assert.equal(nomeDoModelo('claude-opus-5-5'), 'Opus 5.5');
    assert.equal(nomeDoModelo('claude-sonnet-5-5'), 'Sonnet 5.5');
    assert.equal(nomeDoModelo('claude-haiku-4-5-20251001'), 'Haiku 4.5');
    assert.equal(nomeDoModelo('gpt-x'), 'gpt-x');
    assert.equal(nomeDoModelo(null), null);
    assert.equal(tokens(223_000), '223 k');
    assert.equal(tokens(4_100), '4,1 k');
    assert.equal(tokens(812), '812');
    assert.equal(tokens(6_000_000), '6,0 M');
    assert.equal(duracao(12_000), '12 s');
    assert.equal(duracao(28 * 60_000), '28 min');
    assert.equal(duracao(65 * 60_000), '1 h 05 min');
    assert.equal(duracao(null), '—');
    assert.equal(porcento(0.9444), '94%');
    assert.equal(decimal(1.666), '1,7');
    const agora = new Date(2026, 9, 20, 10);
    assert.equal(quando(new Date(2026, 9, 20, 1).toISOString(), agora), 'hoje');
    assert.equal(quando(new Date(2026, 9, 19, 23).toISOString(), agora), 'ontem');
    assert.equal(quando(new Date(2026, 9, 18, 9).toISOString(), agora), 'há 2 dias');
  });

  test('escala curta: menos de 4 min fica com uma casa', () => {
    const e = escalaDaLinha({ inicio: '2026-10-20T10:00:00.000Z', fim: '2026-10-20T10:02:00.000Z' });
    assert.deepEqual(e.marcas, ['0', '0,5 min', '1 min', '1,5 min', '2 min']);
    assert.equal(e.fracao('2026-10-20T10:01:00.000Z'), 0.5);
    assert.equal(e.fracao(null), 1);
  });

  test('layout sobrevive a ciclo e a nó solto', () => {
    const nos = ['a', 'b', 'c', 'solto'].map((id) => ({ id }));
    const { pos } = layoutDoGrafo(nos, [{ de: 'a', para: 'b' }, { de: 'b', para: 'c' }, { de: 'c', para: 'b' }, { de: 'x', para: 'a' }]);
    assert.deepEqual(Object.keys(pos).sort(), ['a', 'b', 'c', 'solto']);
    assert.equal(pos.a.coluna, 0);
  });

  test('a rota leva o filtro e o nó', () => {
    assert.equal(rotaDosWorkflows('todas', null), '/api/workflows?filtro=todas');
    assert.equal(rotaDosWorkflows('ativas', 'subagente:code-reviewer'), '/api/workflows?filtro=ativas&no=subagente%3Acode-reviewer');
  });

  test('Workflows está na barra depois de Analytics, como no wireframe, e todo ícone usado existe', () => {
    const t = TELAS.find((x: any) => x.id === 'workflows');
    assert.deepEqual(t, {
      id: 'workflows',
      rota: '/ui/workflows',
      item: { rotulo: 'Workflows', icone: 'workflows' },
      titulo: 'Workflows',
      sub: 'Como os agentes se orquestram: delegação, rodadas de review e resultado',
      icone: 'workflows',
      arquivo: '/ui/telas/workflows.js',
    });
    const ids = TELAS.map((x: any) => x.id);
    assert.equal(ids.indexOf('workflows'), ids.indexOf('analytics-aba') + 1);
    assert.equal(acharTela('/ui/workflows').tela.id, 'workflows');
    const usados = new Set<string>(['workflows', 'grafo']);
    for (const a of ['workflows.js', 'detalhe-workflow.js']) {
      const texto = readFileSync(`${PASTA_DA_UI}telas/${a}`, 'utf8');
      for (const [, nome] of texto.matchAll(/icone\('([a-z-]+)'\)/g)) usados.add(nome!);
      for (const [, nome] of texto.matchAll(/icone: '([a-z-]+)'/g)) usados.add(nome!);
    }
    for (const nome of usados) assert.ok(NOMES_DOS_ICONES.includes(nome), `falta o ícone ${nome}`);
    // Sem desenho repetido com outro nome: `grafo` é o mesmo de `workflows`, por referência.
    const dom = readFileSync(`${PASTA_DA_UI}dom.js`, 'utf8');
    assert.match(dom, /ICONES\.grafo = ICONES\.workflows;/);
    const desenhos = [...dom.matchAll(/^\s+'?([\w-]+)'?: '(<[^']*)',$/gm)];
    for (const nome of ['workflows', 'usuarios', 'repetir', 'gantt']) {
      const meu = desenhos.find((m) => m[1] === nome)![2];
      assert.deepEqual(desenhos.filter((m) => m[2] === meu).map((m) => m[1]), [nome], `o desenho de ${nome} se repete`);
    }
  });
});
