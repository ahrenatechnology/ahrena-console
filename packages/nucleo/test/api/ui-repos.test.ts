// Os formatos, os filtros e as escalas das telas Repositórios (C22, #104) e Repositório (C23, #105),
// em ui/repos-format.js: puros, sem DOM.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { UI_FOLDER } from '../../src/api/ui.ts';
import {
  bars,
  COMPUTING,
  trafficCardKind,
  screenState,
  changeMatters,
  pending,
  currentResponse,
  NO_GITHUB,
  hasList,
  hasRepo,
  githubUrl,
  valueOrPending,
  signed,
  decimal,
  duration,
  slices,
  filterRepos,
  frequency,
  ago,
  integer,
  kilo,
  languages,
  MINUS,
  thousand,
  periodFrom,
  percentage,
  relative,
  periodLabel,
  withoutAccent,
  sparkline,
  DASH,
  // @ts-expect-error: módulo do navegador, em JavaScript puro
} from '../../ui/repos-format.js';

const MIN = 60_000;
const HORA = 60 * MIN;
const DIA = 24 * HORA;

interface Repo {
  owner: string;
  name: string;
  fullName: string;
  visibility: 'public' | 'private';
  openIssues: number;
  openPrs: number;
  sessions: { active: number; needYou: number; thisMonth: number };
  lastPush: string | null;
}

const repo = (owner: string, name: string, o: Partial<Repo> = {}): Repo => ({
  owner,
  name,
  fullName: `${owner}/${name}`,
  visibility: 'private',
  openIssues: 0,
  openPrs: 0,
  sessions: { active: 0, needYou: 0, thisMonth: 0 },
  lastPush: null,
  ...o,
});

const GRUPOS = [
  {
    owner: 'exemplo-labs',
    type: 'org',
    repos: [
      repo('exemplo-labs', 'vitrine-demo', { visibility: 'public', openIssues: 14, openPrs: 3, sessions: { active: 4, needYou: 1, thisMonth: 7 }, lastPush: '2026-10-20T10:00:00Z' }),
      repo('exemplo-labs', 'motor-de-regras', { openIssues: 9, openPrs: 5, sessions: { active: 3, needYou: 2, thisMonth: 5 }, lastPush: '2026-10-20T11:00:00Z' }),
      repo('exemplo-labs', 'gateway-sandbox', { openIssues: 4, openPrs: 1, lastPush: '2026-10-19T10:00:00Z' }),
    ],
  },
  {
    owner: 'estudio-ficticio',
    type: 'org',
    repos: [repo('estudio-ficticio', 'catálogo-exemplo', { visibility: 'public', sessions: { active: 0, needYou: 0, thisMonth: 1 }, lastPush: null })],
  },
  { owner: 'dev-sintetico', type: 'personal', repos: [repo('dev-sintetico', 'cli-de-notas', { visibility: 'public', lastPush: '2026-10-18T10:00:00Z' })] },
];

const nomes = (gs: { owner: string; repos: Repo[] }[]) => gs.map((g) => [g.owner, g.repos.map((r) => r.name)]);

describe('repos na /ui: os números', () => {
  test('#104 critério 2: inteiros pt-BR e o traço para o que não veio', () => {
    assert.equal(integer(1204), '1.204');
    assert.equal(integer(0), '0');
    assert.equal(integer(null), DASH);
    assert.equal(integer(undefined), DASH);
    assert.equal(decimal(1.6), '1,6');
    assert.equal(decimal(null), DASH);
  });

  test('#105 critério 1: linhas em mil e saldo com sinal', () => {
    assert.equal(thousand(48_300), '48,3 mil');
    assert.equal(thousand(109_572), '109,6 mil');
    assert.equal(thousand(1_250_000), '1,3 mi');
    assert.equal(thousand(737), '737');
    assert.equal(signed(6_100, thousand), '+6,1 mil');
    assert.equal(signed(-6_100, thousand), `${MINUS}6,1 mil`);
    assert.equal(signed(0, thousand), '0');
    assert.equal(signed(null, thousand), DASH);
  });

  test('#105 critério 1: adicionadas e removidas em k, com o menos tipográfico', () => {
    assert.equal(MINUS, '−');
    assert.equal(signed(61_400, kilo), '+61,4 k');
    assert.equal(signed(-21_500, kilo), '−21,5 k');
    assert.equal(signed(212), '+212');
    assert.equal(signed(-64), '−64');
    assert.equal(kilo(999), '999');
  });

  test('#105 critério 1: mil e k arredondam antes de escolher a escala', () => {
    assert.equal(kilo(999.6), '1,0 k');
    assert.equal(thousand(999.6), '1,0 mil');
    assert.equal(thousand(999_960), '1,0 mi');
    assert.equal(kilo(999.4), '999');
  });

  test('#105 critério 1: mil só vira mi quando arredondar daria 1.000,0 mil', () => {
    assert.equal(thousand(950_000), '950,0 mil');
    assert.equal(thousand(960_000), '960,0 mil');
    assert.equal(thousand(999_949), '999,9 mil');
    assert.equal(thousand(999_950), '1,0 mi');
    assert.equal(thousand(1_000_000), '1,0 mi');
  });

  test('#105 critério 3: durações a partir de ms', () => {
    assert.equal(duration(DIA + 4 * HORA + 20 * MIN), '1 d 4 h');
    assert.equal(duration(2 * DIA), '2 d');
    assert.equal(duration(3 * HORA + 12 * MIN), '3 h 12');
    assert.equal(duration(3 * HORA + 5 * MIN), '3 h 05');
    assert.equal(duration(2 * HORA), '2 h');
    assert.equal(duration(6 * MIN + 30_000), '6 min');
    assert.equal(duration(20_000), '< 1 min');
    assert.equal(duration(null), DASH);
  });

  test('#105 critério 4: porcentagem de 0 a 1', () => {
    assert.equal(percentage(0.9694), '97%');
    assert.equal(percentage(0), '0%');
    assert.equal(percentage(null), DASH);
  });

  test('#104 critério 2: o último push, relativo', () => {
    const agora = Date.parse('2026-10-20T12:00:00Z');
    const antes = (ms: number) => new Date(agora - ms).toISOString();
    assert.equal(relative(antes(20_000), agora), 'agora');
    assert.equal(relative(antes(-5_000), agora), 'agora', 'relógio adiantado');
    assert.equal(relative(antes(2 * MIN), agora), '2 min');
    assert.equal(relative(antes(HORA), agora), '1 h');
    assert.equal(relative(antes(30 * HORA), agora), 'ontem');
    assert.equal(relative(antes(2 * DIA), agora), '2 dias');
    assert.equal(relative(antes(90 * DIA), agora), '3 meses');
    assert.equal(relative(antes(400 * DIA), agora), '1 ano');
    assert.equal(relative(null, agora), DASH);
    assert.equal(relative('lixo', agora), DASH);
    assert.equal(ago(antes(6 * DIA), agora), 'há 6 dias');
    assert.equal(ago(antes(30 * HORA), agora), 'ontem');
  });

  test('#105 critério 6: o período vem de ?period= (o valor da API, 1y para o ano) e cai no padrão se estranho', () => {
    assert.equal(periodFrom('?period=30d'), '30d');
    assert.equal(periodFrom('?period=1y'), '1y');
    assert.equal(periodFrom('?period=1a'), '90d', 'the old value is not read (#173, phase 6)');
    assert.equal(periodFrom(''), '90d');
    assert.equal(periodFrom('?period=7d'), '90d');
    assert.equal(periodFrom('?periodo=30d'), '90d', 'the old query is not read (#173, phase 6)');
    assert.equal(periodLabel('30d'), '30 dias');
    assert.equal(periodLabel('1y'), '1 ano');
  });
});

describe('repos na /ui: a lista (C22)', () => {
  test('#104 critério 1: busca por nome ou dono/nome, sem acento nem caixa', () => {
    assert.equal(withoutAccent('Catálogo'), 'catalogo');
    assert.deepEqual(nomes(filterRepos(GRUPOS, { busca: 'CATALOGO' })), [['estudio-ficticio', ['catálogo-exemplo']]]);
    assert.deepEqual(nomes(filterRepos(GRUPOS, { busca: 'labs/motor' })), [['exemplo-labs', ['motor-de-regras']]]);
    assert.deepEqual(filterRepos(GRUPOS, { busca: 'nada-disso' }), [], 'grupo vazio some');
  });

  test('#104 critério 1: filtro por organização', () => {
    assert.deepEqual(
      filterRepos(GRUPOS, { dono: 'dev-sintetico' }).map((g: { owner: string }) => g.owner),
      ['dev-sintetico'],
    );
    assert.equal(filterRepos(GRUPOS, { dono: '' }).length, 3);
  });

  test('#104 critério 1: visibilidade e "com sessões" (viva ou no mês)', () => {
    assert.deepEqual(nomes(filterRepos(GRUPOS, { vis: 'publicos' })), [
      ['exemplo-labs', ['vitrine-demo']],
      ['estudio-ficticio', ['catálogo-exemplo']],
      ['dev-sintetico', ['cli-de-notas']],
    ]);
    assert.deepEqual(nomes(filterRepos(GRUPOS, { vis: 'privados' })), [['exemplo-labs', ['motor-de-regras', 'gateway-sandbox']]]);
    assert.deepEqual(nomes(filterRepos(GRUPOS, { vis: 'com-sessoes' })), [
      ['exemplo-labs', ['motor-de-regras', 'vitrine-demo']],
      ['estudio-ficticio', ['catálogo-exemplo']],
    ]);
  });

  test('#104 critério 1: ordenação por atividade (padrão), nome, issues, PRs e sessões', () => {
    const lab = (ordem: string) => filterRepos(GRUPOS, { dono: 'exemplo-labs', ordem })[0].repos.map((r: Repo) => r.name);
    assert.deepEqual(lab('recente'), ['motor-de-regras', 'vitrine-demo', 'gateway-sandbox']);
    assert.deepEqual(filterRepos(GRUPOS, { dono: 'exemplo-labs' })[0].repos.map((r: Repo) => r.name), lab('recente'));
    assert.deepEqual(lab('nome'), ['gateway-sandbox', 'motor-de-regras', 'vitrine-demo']);
    assert.deepEqual(lab('issues'), ['vitrine-demo', 'motor-de-regras', 'gateway-sandbox']);
    assert.deepEqual(lab('prs'), ['motor-de-regras', 'vitrine-demo', 'gateway-sandbox']);
    assert.deepEqual(lab('sessoes'), ['vitrine-demo', 'motor-de-regras', 'gateway-sandbox']);
  });

  test('filtrar não mexe nos grupos do núcleo', () => {
    const antes = JSON.stringify(GRUPOS);
    filterRepos(GRUPOS, { ordem: 'nome', vis: 'publicos' });
    assert.equal(JSON.stringify(GRUPOS), antes);
  });
});

describe('repos na /ui: as escalas dos gráficos', () => {
  test('#104 critério 2: sparkline dos commits de 12 semanas; sem semanas, nada', () => {
    assert.equal(sparkline([]), null);
    assert.equal(sparkline(undefined), null);
    const pts = sparkline([0, 5, 10], 90, 22).split(' ');
    assert.deepEqual(pts, ['1,20', '45,11', '89,2']);
    assert.equal(sparkline([0, 0, 0], 90, 22), '1,20 45,20 89,20', 'tudo zero fica rente ao chão');
  });

  test('#105 critério 1: barras dos commits por semana, a maior no topo', () => {
    const b = bars([1, 2, 4], 300, 90);
    assert.equal(b.length, 3);
    assert.equal(b[2].y, 6);
    assert.equal(b[2].altura, 84);
    assert.equal(b[0].altura, 21);
    assert.equal(b[1].x, 101);
    assert.deepEqual(bars([]), []);
  });

  test('#105 critério 1: frequência com adicionadas para cima e removidas para baixo, mesma escala', () => {
    const f = frequency(
      [
        { week: 'a', added: 100, removed: 50 },
        { week: 'b', added: 20, removed: 100 },
      ],
      200,
      64,
      58,
      52,
    );
    assert.equal(f[0].cima.altura, 58);
    assert.equal(f[0].cima.y, 6);
    assert.equal(f[0].baixo.y, 64);
    assert.equal(f[0].baixo.altura, 26);
    assert.equal(f[1].baixo.altura, 52);
    assert.deepEqual(frequency([]), []);
  });

  test('#105 critério 3 e 4: fatias da barra empilhada e linguagens com "Outras"', () => {
    assert.deepEqual(slices([61, 4, 3]), [89.7, 5.9, 4.4]);
    assert.deepEqual(slices([0, 0]), [0, 0]);
    const l = languages([
      { name: 'CSS', bytes: 12, share: 0.12 },
      { name: 'TypeScript', bytes: 71, share: 0.71 },
      { name: 'HTML', bytes: 9, share: 0.09 },
      { name: 'Shell', bytes: 5, share: 0.05 },
      { name: 'JavaScript', bytes: 2, share: 0.02 },
      { name: 'Dockerfile', bytes: 1, share: 0.01 },
    ]);
    assert.deepEqual(l.map((x: { nome: string }) => x.nome), ['TypeScript', 'CSS', 'HTML', 'Shell', 'Outras']);
    assert.equal(Math.round(l[4].pct), 3);
    assert.deepEqual(languages(null), []);
    assert.equal(languages([{ name: 'Go', bytes: 10, share: 1 }]).length, 1, 'sem resto, sem "Outras"');
  });
});

describe('repos na /ui: o que a tela mostra', () => {
  const lista = (o = {}) => ({ state: 'ready', updatedAt: '2026-10-20T10:00:00Z', error: null, groups: [], ...o });
  const metricas = (o: { traffic?: unknown; [k: string]: unknown } = {}) => ({ state: 'ready', error: null, computing: [], repo: { fullName: 'a/b' }, ...o });

  test('#104 critério 3: estado da tela sem dado (carregando, lendo, sem GitHub, erro)', () => {
    assert.deepEqual(screenState({}), { tela: 'loading', faixa: null, reler: false });
    const semDado = lista({ updatedAt: null });
    assert.equal(hasList(semDado), false);
    assert.deepEqual(screenState({ dados: { ...semDado, state: 'loading' }, temDado: false }), { tela: 'reading', faixa: null, reler: true });
    assert.equal(screenState({ dados: { ...semDado, state: 'no-github' }, temDado: false }).tela, 'no-github');
    assert.equal(screenState({ dados: { ...semDado, state: 'error', error: 'limite' }, temDado: false }).tela, 'error');
    assert.equal(screenState({ falha: new Error('sem núcleo'), temDado: false }).tela, 'error');
    assert.equal(screenState({ dados: semDado, temDado: false }).tela, 'empty');
  });

  test('#104 critério 3: erro com dado anterior mostra a faixa e os dados', () => {
    const d = lista({ error: 'dado de 24 h', groups: [{ owner: 'x', type: 'org', repos: [] }] });
    assert.equal(hasList(d), true);
    assert.deepEqual(screenState({ dados: d, temDado: true }), { tela: 'data', faixa: 'github', reler: false });
    assert.equal(screenState({ dados: d, falha: new Error('caiu'), temDado: true }).faixa, 'connection');
    assert.equal(screenState({ dados: lista(), temDado: true }).faixa, null);
  });

  test('#105: estado das métricas (não encontrado, montagem parcial, calculando)', () => {
    assert.equal(screenState({ dados: metricas({ state: 'not-found', repo: null }), temDado: false }).tela, 'not-found');
    const parcial = metricas({ state: 'loading' });
    assert.equal(hasRepo(parcial), true);
    assert.deepEqual(screenState({ dados: parcial, temDado: true }), { tela: 'data', faixa: null, reler: true });
    assert.equal(screenState({ dados: metricas({ computing: ['commits'] }), temDado: true }).reler, true);
    assert.equal(screenState({ dados: metricas(), temDado: true }).reler, false);
  });

  test('#105 critério 1: valor, "calculando…" ou "—", nunca número inventado', () => {
    const d = metricas({ computing: ['lines'] });
    assert.deepEqual(valueOrPending(48_300, d, 'lines', thousand), { texto: '48,3 mil', pendente: false });
    assert.deepEqual(valueOrPending(0, d, 'commits', integer), { texto: '0', pendente: false }, 'zero é valor');
    assert.deepEqual(valueOrPending(null, d, 'lines'), { texto: COMPUTING, pendente: true });
    assert.deepEqual(valueOrPending(null, d, 'commits'), { texto: DASH, pendente: false });
    assert.equal(valueOrPending(null, metricas({ state: 'loading' }), 'prs').texto, COMPUTING, 'montagem parcial');
    assert.equal(pending(metricas(), 'lines'), false);
  });

  test('#104 e #105: a mudança do Ao vivo que pede releitura (lista e a chave sem caixa)', () => {
    assert.equal(changeMatters([{ type: 'repos', key: 'list' }]), true);
    assert.equal(changeMatters([{ type: 'repos', key: 'exemplo-labs/vitrine-demo' }]), false, 'a lista só relê por `list`');
    assert.equal(changeMatters([{ type: 'session', key: 'list' }]), false);
    assert.equal(changeMatters([{ type: 'repos', key: 'exemplo-labs/vitrine-demo' }], 'Exemplo-Labs/Vitrine-Demo'), true);
    assert.equal(changeMatters([{ type: 'repos', key: 'list' }], 'a/b'), true);
    assert.equal(changeMatters([{ type: 'repos', key: 'a/c' }], 'a/b'), false);
    assert.equal(changeMatters([], 'a/b'), false);
  });

  test('#105 critério 5: o card de tráfego só com escrita; sem ela, "Comunidade"', () => {
    assert.equal(trafficCardKind(metricas({ canWrite: true, traffic: { views: 1 }, security: {} })), 'traffic');
    // Com escrita e a montagem ainda sem as chaves: o card fica, com "calculando…".
    const parcial = metricas({ state: 'loading', canWrite: true });
    assert.equal(trafficCardKind(parcial), 'traffic');
    assert.equal(valueOrPending(parcial.traffic, parcial, 'traffic').texto, COMPUTING);
    assert.equal(trafficCardKind(metricas({ canWrite: false })), 'community');
  });

  test('#105: link externo só https em github.com', () => {
    assert.equal(githubUrl('https://github.com/exemplo-labs/vitrine-demo'), 'https://github.com/exemplo-labs/vitrine-demo');
    for (const url of ['http://github.com/a/b', 'https://github.com.exemplo.com/a/b', 'https://exemplo.com/a/b', 'javascript:alert(1)', '', null, 'lixo']) assert.equal(githubUrl(url), null, String(url));
  });

  test('#105 critério 6: resposta de período trocado ou de pedido velho é descartada', () => {
    assert.equal(currentResponse({ pedido: 2, ultimo: 2, periodo: '90d', periodoAtual: '90d' }), true);
    assert.equal(currentResponse({ pedido: 2, ultimo: 2, periodo: '90d', periodoAtual: '30d' }), false);
    assert.equal(currentResponse({ pedido: 1, ultimo: 2, periodo: '90d', periodoAtual: '90d' }), false);
  });

  test('sem GitHub: um texto só, que diz como configurar', () => {
    // issue 241: no terminal command; --no-github or a dropped connection, and Conexões.
    assert.doesNotMatch(NO_GITHUB.text, /gh auth login/);
    assert.match(NO_GITHUB.text, /--no-github/);
    assert.match(NO_GITHUB.text, /Conexões/);
    assert.match(NO_GITHUB.title, /sem o GitHub/);
  });
});

// O CSS de cada tela fica carregado quando se troca de tela: uma classe com o mesmo nome em duas
// telas desmonta a outra. Toda classe própria começa com `repo-`; as comuns são as da moldura e os
// selos de status.
describe('repos na /ui: as classes', () => {
  const SELOS = new Set(['badge', 'p', 'reason', 'soft', 'b-active', 'b-waiting', 'b-completed', 'b-error', 'b-abandoned']);
  const classesDoCss = (arquivo: string) => new Set([...readFileSync(`${UI_FOLDER}${arquivo}`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.([a-z][a-z0-9-]*)/g)].map((m) => m[1]!));
  const daMoldura = classesDoCss('shell.css');
  const permitida = (c: string) => c.startsWith('repo-') || SELOS.has(c) || daMoldura.has(c);

  test('toda classe de repos.css começa com repo-, é selo ou é da moldura', () => {
    assert.deepEqual([...classesDoCss('repos.css')].filter((c) => !permitida(c)), []);
  });

  test('repos.css não estiliza classe de outra tela, fora selos e moldura', () => {
    const minhas = new Set([...classesDoCss('repos.css')].filter((c) => !daMoldura.has(c)));
    const outras = [
      ...readdirSync(UI_FOLDER).filter((a) => a.endsWith('.css') && !['repos.css', 'shell.css', 'brand.css'].includes(a)),
      ...readdirSync(`${UI_FOLDER}screens`).filter((a) => a.endsWith('.css')).map((a) => `screens/${a}`),
    ];
    assert.ok(outras.includes('screens/session-detail.css'));
    for (const outra of outras) {
      assert.deepEqual([...classesDoCss(outra)].filter((c) => minhas.has(c) && !SELOS.has(c)), [], `repos.css e ${outra} estilizam as mesmas classes`);
    }
  });

  test('as telas só usam classe da moldura, selo ou repo-', () => {
    for (const arquivo of ['screens/repos.js', 'screens/repo.js']) {
      const fonte = readFileSync(`${UI_FOLDER}${arquivo}`, 'utf8');
      const usadas = new Set<string>();
      for (const [, , valor] of fonte.matchAll(/class:\s*(['`])(.*?)\1/g)) for (const c of valor!.replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)) if (c) usadas.add(c);
      // Classes passadas por variável (`barraH(pct, 'repo-k-ok')`, as cores): toda string que parece classe.
      for (const [, c] of fonte.matchAll(/'(repo-[a-z0-9-]+)'/g)) usadas.add(c!);
      assert.ok(usadas.size > 10, arquivo);
      assert.deepEqual([...usadas].filter((c) => !permitida(c)), [], arquivo);
      const css = classesDoCss('repos.css');
      assert.deepEqual([...usadas].filter((c) => c.startsWith('repo-') && !css.has(c)), [], `${arquivo} usa classe que repos.css não tem`);
    }
  });
});
