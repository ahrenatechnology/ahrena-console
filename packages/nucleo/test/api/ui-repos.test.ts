// Os formatos, os filtros e as escalas das telas Repositórios (C22, #104) e Repositório (C23, #105),
// em ui/repos-format.js: puros, sem DOM.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { PASTA_DA_UI } from '../../src/api/ui.ts';
import {
  barras,
  CALCULANDO,
  cardDeTrafego,
  estadoDaTela,
  mudancaInteressa,
  pendente,
  respostaAtual,
  SEM_GITHUB,
  temLista,
  temRepo,
  urlDoGithub,
  valorOuPendente,
  comSinal,
  decimal,
  duracao,
  fatias,
  filtrarRepos,
  frequencia,
  ha,
  inteiro,
  kilo,
  linguagens,
  MENOS,
  mil,
  periodInUrl,
  periodoDe,
  porcentagem,
  relativo,
  rotuloDoPeriodo,
  semAcento,
  sparkline,
  TRACO,
  // @ts-expect-error: módulo do navegador, em JavaScript puro
} from '../../ui/repos-format.js';

const MIN = 60_000;
const HORA = 60 * MIN;
const DIA = 24 * HORA;

interface Repo {
  dono: string;
  nome: string;
  completo: string;
  visibilidade: 'publico' | 'privado';
  issuesAbertas: number;
  prsAbertos: number;
  sessoes: { ativas: number; precisam: number; noMes: number };
  ultimoPush: string | null;
}

const repo = (dono: string, nome: string, o: Partial<Repo> = {}): Repo => ({
  dono,
  nome,
  completo: `${dono}/${nome}`,
  visibilidade: 'privado',
  issuesAbertas: 0,
  prsAbertos: 0,
  sessoes: { ativas: 0, precisam: 0, noMes: 0 },
  ultimoPush: null,
  ...o,
});

const GRUPOS = [
  {
    dono: 'exemplo-labs',
    tipo: 'org',
    repos: [
      repo('exemplo-labs', 'vitrine-demo', { visibilidade: 'publico', issuesAbertas: 14, prsAbertos: 3, sessoes: { ativas: 4, precisam: 1, noMes: 7 }, ultimoPush: '2026-10-20T10:00:00Z' }),
      repo('exemplo-labs', 'motor-de-regras', { issuesAbertas: 9, prsAbertos: 5, sessoes: { ativas: 3, precisam: 2, noMes: 5 }, ultimoPush: '2026-10-20T11:00:00Z' }),
      repo('exemplo-labs', 'gateway-sandbox', { issuesAbertas: 4, prsAbertos: 1, ultimoPush: '2026-10-19T10:00:00Z' }),
    ],
  },
  {
    dono: 'estudio-ficticio',
    tipo: 'org',
    repos: [repo('estudio-ficticio', 'catálogo-exemplo', { visibilidade: 'publico', sessoes: { ativas: 0, precisam: 0, noMes: 1 }, ultimoPush: null })],
  },
  { dono: 'dev-sintetico', tipo: 'pessoal', repos: [repo('dev-sintetico', 'cli-de-notas', { visibilidade: 'publico', ultimoPush: '2026-10-18T10:00:00Z' })] },
];

const nomes = (gs: { dono: string; repos: Repo[] }[]) => gs.map((g) => [g.dono, g.repos.map((r) => r.nome)]);

describe('repos na /ui: os números', () => {
  test('#104 critério 2: inteiros pt-BR e o traço para o que não veio', () => {
    assert.equal(inteiro(1204), '1.204');
    assert.equal(inteiro(0), '0');
    assert.equal(inteiro(null), TRACO);
    assert.equal(inteiro(undefined), TRACO);
    assert.equal(decimal(1.6), '1,6');
    assert.equal(decimal(null), TRACO);
  });

  test('#105 critério 1: linhas em mil e saldo com sinal', () => {
    assert.equal(mil(48_300), '48,3 mil');
    assert.equal(mil(109_572), '109,6 mil');
    assert.equal(mil(1_250_000), '1,3 mi');
    assert.equal(mil(737), '737');
    assert.equal(comSinal(6_100, mil), '+6,1 mil');
    assert.equal(comSinal(-6_100, mil), `${MENOS}6,1 mil`);
    assert.equal(comSinal(0, mil), '0');
    assert.equal(comSinal(null, mil), TRACO);
  });

  test('#105 critério 1: adicionadas e removidas em k, com o menos tipográfico', () => {
    assert.equal(MENOS, '−');
    assert.equal(comSinal(61_400, kilo), '+61,4 k');
    assert.equal(comSinal(-21_500, kilo), '−21,5 k');
    assert.equal(comSinal(212), '+212');
    assert.equal(comSinal(-64), '−64');
    assert.equal(kilo(999), '999');
  });

  test('#105 critério 1: mil e k arredondam antes de escolher a escala', () => {
    assert.equal(kilo(999.6), '1,0 k');
    assert.equal(mil(999.6), '1,0 mil');
    assert.equal(mil(999_960), '1,0 mi');
    assert.equal(kilo(999.4), '999');
  });

  test('#105 critério 1: mil só vira mi quando arredondar daria 1.000,0 mil', () => {
    assert.equal(mil(950_000), '950,0 mil');
    assert.equal(mil(960_000), '960,0 mil');
    assert.equal(mil(999_949), '999,9 mil');
    assert.equal(mil(999_950), '1,0 mi');
    assert.equal(mil(1_000_000), '1,0 mi');
  });

  test('#105 critério 3: durações a partir de ms', () => {
    assert.equal(duracao(DIA + 4 * HORA + 20 * MIN), '1 d 4 h');
    assert.equal(duracao(2 * DIA), '2 d');
    assert.equal(duracao(3 * HORA + 12 * MIN), '3 h 12');
    assert.equal(duracao(3 * HORA + 5 * MIN), '3 h 05');
    assert.equal(duracao(2 * HORA), '2 h');
    assert.equal(duracao(6 * MIN + 30_000), '6 min');
    assert.equal(duracao(20_000), '< 1 min');
    assert.equal(duracao(null), TRACO);
  });

  test('#105 critério 4: porcentagem de 0 a 1', () => {
    assert.equal(porcentagem(0.9694), '97%');
    assert.equal(porcentagem(0), '0%');
    assert.equal(porcentagem(null), TRACO);
  });

  test('#104 critério 2: o último push, relativo', () => {
    const agora = Date.parse('2026-10-20T12:00:00Z');
    const antes = (ms: number) => new Date(agora - ms).toISOString();
    assert.equal(relativo(antes(20_000), agora), 'agora');
    assert.equal(relativo(antes(-5_000), agora), 'agora', 'relógio adiantado');
    assert.equal(relativo(antes(2 * MIN), agora), '2 min');
    assert.equal(relativo(antes(HORA), agora), '1 h');
    assert.equal(relativo(antes(30 * HORA), agora), 'ontem');
    assert.equal(relativo(antes(2 * DIA), agora), '2 dias');
    assert.equal(relativo(antes(90 * DIA), agora), '3 meses');
    assert.equal(relativo(antes(400 * DIA), agora), '1 ano');
    assert.equal(relativo(null, agora), TRACO);
    assert.equal(relativo('lixo', agora), TRACO);
    assert.equal(ha(antes(6 * DIA), agora), 'há 6 dias');
    assert.equal(ha(antes(30 * HORA), agora), 'ontem');
  });

  test('#105 critério 6: o período vem de ?period= (1y na URL é o 1a da API) e cai no padrão se estranho', () => {
    assert.equal(periodoDe('?period=30d'), '30d');
    assert.equal(periodoDe('?period=1y'), '1a');
    assert.equal(periodoDe(''), '90d');
    assert.equal(periodoDe('?period=7d'), '90d');
    assert.equal(periodoDe('?periodo=30d'), '90d', 'the old query is the shell router\'s job (legacyUrl)');
    assert.equal(periodInUrl('1a'), '1y');
    assert.equal(periodInUrl('30d'), '30d');
    assert.equal(rotuloDoPeriodo('30d'), '30 dias');
    assert.equal(rotuloDoPeriodo('1a'), '1 ano');
  });
});

describe('repos na /ui: a lista (C22)', () => {
  test('#104 critério 1: busca por nome ou dono/nome, sem acento nem caixa', () => {
    assert.equal(semAcento('Catálogo'), 'catalogo');
    assert.deepEqual(nomes(filtrarRepos(GRUPOS, { busca: 'CATALOGO' })), [['estudio-ficticio', ['catálogo-exemplo']]]);
    assert.deepEqual(nomes(filtrarRepos(GRUPOS, { busca: 'labs/motor' })), [['exemplo-labs', ['motor-de-regras']]]);
    assert.deepEqual(filtrarRepos(GRUPOS, { busca: 'nada-disso' }), [], 'grupo vazio some');
  });

  test('#104 critério 1: filtro por organização', () => {
    assert.deepEqual(
      filtrarRepos(GRUPOS, { dono: 'dev-sintetico' }).map((g: { dono: string }) => g.dono),
      ['dev-sintetico'],
    );
    assert.equal(filtrarRepos(GRUPOS, { dono: '' }).length, 3);
  });

  test('#104 critério 1: visibilidade e "com sessões" (viva ou no mês)', () => {
    assert.deepEqual(nomes(filtrarRepos(GRUPOS, { vis: 'publicos' })), [
      ['exemplo-labs', ['vitrine-demo']],
      ['estudio-ficticio', ['catálogo-exemplo']],
      ['dev-sintetico', ['cli-de-notas']],
    ]);
    assert.deepEqual(nomes(filtrarRepos(GRUPOS, { vis: 'privados' })), [['exemplo-labs', ['motor-de-regras', 'gateway-sandbox']]]);
    assert.deepEqual(nomes(filtrarRepos(GRUPOS, { vis: 'com-sessoes' })), [
      ['exemplo-labs', ['motor-de-regras', 'vitrine-demo']],
      ['estudio-ficticio', ['catálogo-exemplo']],
    ]);
  });

  test('#104 critério 1: ordenação por atividade (padrão), nome, issues, PRs e sessões', () => {
    const lab = (ordem: string) => filtrarRepos(GRUPOS, { dono: 'exemplo-labs', ordem })[0].repos.map((r: Repo) => r.nome);
    assert.deepEqual(lab('recente'), ['motor-de-regras', 'vitrine-demo', 'gateway-sandbox']);
    assert.deepEqual(filtrarRepos(GRUPOS, { dono: 'exemplo-labs' })[0].repos.map((r: Repo) => r.nome), lab('recente'));
    assert.deepEqual(lab('nome'), ['gateway-sandbox', 'motor-de-regras', 'vitrine-demo']);
    assert.deepEqual(lab('issues'), ['vitrine-demo', 'motor-de-regras', 'gateway-sandbox']);
    assert.deepEqual(lab('prs'), ['motor-de-regras', 'vitrine-demo', 'gateway-sandbox']);
    assert.deepEqual(lab('sessoes'), ['vitrine-demo', 'motor-de-regras', 'gateway-sandbox']);
  });

  test('filtrar não mexe nos grupos do núcleo', () => {
    const antes = JSON.stringify(GRUPOS);
    filtrarRepos(GRUPOS, { ordem: 'nome', vis: 'publicos' });
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
    const b = barras([1, 2, 4], 300, 90);
    assert.equal(b.length, 3);
    assert.equal(b[2].y, 6);
    assert.equal(b[2].altura, 84);
    assert.equal(b[0].altura, 21);
    assert.equal(b[1].x, 101);
    assert.deepEqual(barras([]), []);
  });

  test('#105 critério 1: frequência com adicionadas para cima e removidas para baixo, mesma escala', () => {
    const f = frequencia(
      [
        { semana: 'a', adicionadas: 100, removidas: 50 },
        { semana: 'b', adicionadas: 20, removidas: 100 },
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
    assert.deepEqual(frequencia([]), []);
  });

  test('#105 critério 3 e 4: fatias da barra empilhada e linguagens com "Outras"', () => {
    assert.deepEqual(fatias([61, 4, 3]), [89.7, 5.9, 4.4]);
    assert.deepEqual(fatias([0, 0]), [0, 0]);
    const l = linguagens([
      { nome: 'CSS', bytes: 12, fatia: 0.12 },
      { nome: 'TypeScript', bytes: 71, fatia: 0.71 },
      { nome: 'HTML', bytes: 9, fatia: 0.09 },
      { nome: 'Shell', bytes: 5, fatia: 0.05 },
      { nome: 'JavaScript', bytes: 2, fatia: 0.02 },
      { nome: 'Dockerfile', bytes: 1, fatia: 0.01 },
    ]);
    assert.deepEqual(l.map((x: { nome: string }) => x.nome), ['TypeScript', 'CSS', 'HTML', 'Shell', 'Outras']);
    assert.equal(Math.round(l[4].pct), 3);
    assert.deepEqual(linguagens(null), []);
    assert.equal(linguagens([{ nome: 'Go', bytes: 10, fatia: 1 }]).length, 1, 'sem resto, sem "Outras"');
  });
});

describe('repos na /ui: o que a tela mostra', () => {
  const lista = (o = {}) => ({ estado: 'pronto', atualizadoEm: '2026-10-20T10:00:00Z', erro: null, grupos: [], ...o });
  const metricas = (o = {}) => ({ estado: 'pronto', erro: null, calculando: [], repo: { completo: 'a/b' }, ...o });

  test('#104 critério 3: estado da tela sem dado (carregando, lendo, sem GitHub, erro)', () => {
    assert.deepEqual(estadoDaTela({}), { tela: 'carregando', faixa: null, reler: false });
    const semDado = lista({ atualizadoEm: null });
    assert.equal(temLista(semDado), false);
    assert.deepEqual(estadoDaTela({ dados: { ...semDado, estado: 'carregando' }, temDado: false }), { tela: 'lendo', faixa: null, reler: true });
    assert.equal(estadoDaTela({ dados: { ...semDado, estado: 'sem-github' }, temDado: false }).tela, 'sem-github');
    assert.equal(estadoDaTela({ dados: { ...semDado, estado: 'erro', erro: 'limite' }, temDado: false }).tela, 'erro');
    assert.equal(estadoDaTela({ falha: new Error('sem núcleo'), temDado: false }).tela, 'erro');
    assert.equal(estadoDaTela({ dados: semDado, temDado: false }).tela, 'vazio');
  });

  test('#104 critério 3: erro com dado anterior mostra a faixa e os dados', () => {
    const d = lista({ erro: 'dado de 24 h', grupos: [{ dono: 'x', tipo: 'org', repos: [] }] });
    assert.equal(temLista(d), true);
    assert.deepEqual(estadoDaTela({ dados: d, temDado: true }), { tela: 'dados', faixa: 'github', reler: false });
    assert.equal(estadoDaTela({ dados: d, falha: new Error('caiu'), temDado: true }).faixa, 'conexao');
    assert.equal(estadoDaTela({ dados: lista(), temDado: true }).faixa, null);
  });

  test('#105: estado das métricas (não encontrado, montagem parcial, calculando)', () => {
    assert.equal(estadoDaTela({ dados: metricas({ estado: 'nao-encontrado', repo: null }), temDado: false }).tela, 'nao-encontrado');
    const parcial = metricas({ estado: 'carregando' });
    assert.equal(temRepo(parcial), true);
    assert.deepEqual(estadoDaTela({ dados: parcial, temDado: true }), { tela: 'dados', faixa: null, reler: true });
    assert.equal(estadoDaTela({ dados: metricas({ calculando: ['commits'] }), temDado: true }).reler, true);
    assert.equal(estadoDaTela({ dados: metricas(), temDado: true }).reler, false);
  });

  test('#105 critério 1: valor, "calculando…" ou "—", nunca número inventado', () => {
    const d = metricas({ calculando: ['linhas'] });
    assert.deepEqual(valorOuPendente(48_300, d, 'linhas', mil), { texto: '48,3 mil', pendente: false });
    assert.deepEqual(valorOuPendente(0, d, 'commits', inteiro), { texto: '0', pendente: false }, 'zero é valor');
    assert.deepEqual(valorOuPendente(null, d, 'linhas'), { texto: CALCULANDO, pendente: true });
    assert.deepEqual(valorOuPendente(null, d, 'commits'), { texto: TRACO, pendente: false });
    assert.equal(valorOuPendente(null, metricas({ estado: 'carregando' }), 'prs').texto, CALCULANDO, 'montagem parcial');
    assert.equal(pendente(metricas(), 'linhas'), false);
  });

  test('#104 e #105: a mudança do Ao vivo que pede releitura (lista e a chave sem caixa)', () => {
    assert.equal(mudancaInteressa([{ tipo: 'repos', chave: 'lista' }]), true);
    assert.equal(mudancaInteressa([{ tipo: 'repos', chave: 'exemplo-labs/vitrine-demo' }]), false, 'a lista só relê por `lista`');
    assert.equal(mudancaInteressa([{ tipo: 'sessao', chave: 'lista' }]), false);
    assert.equal(mudancaInteressa([{ tipo: 'repos', chave: 'exemplo-labs/vitrine-demo' }], 'Exemplo-Labs/Vitrine-Demo'), true);
    assert.equal(mudancaInteressa([{ tipo: 'repos', chave: 'lista' }], 'a/b'), true);
    assert.equal(mudancaInteressa([{ tipo: 'repos', chave: 'a/c' }], 'a/b'), false);
    assert.equal(mudancaInteressa([], 'a/b'), false);
  });

  test('#105 critério 5: o card de tráfego só com escrita; sem ela, "Comunidade"', () => {
    assert.equal(cardDeTrafego(metricas({ escrita: true, trafego: { visitas: 1 }, seguranca: {} })), 'trafego');
    // Com escrita e a montagem ainda sem as chaves: o card fica, com "calculando…".
    const parcial = metricas({ estado: 'carregando', escrita: true });
    assert.equal(cardDeTrafego(parcial), 'trafego');
    assert.equal(valorOuPendente(parcial.trafego, parcial, 'trafego').texto, CALCULANDO);
    assert.equal(cardDeTrafego(metricas({ escrita: false })), 'comunidade');
  });

  test('#105: link externo só https em github.com', () => {
    assert.equal(urlDoGithub('https://github.com/exemplo-labs/vitrine-demo'), 'https://github.com/exemplo-labs/vitrine-demo');
    for (const url of ['http://github.com/a/b', 'https://github.com.exemplo.com/a/b', 'https://exemplo.com/a/b', 'javascript:alert(1)', '', null, 'lixo']) assert.equal(urlDoGithub(url), null, String(url));
  });

  test('#105 critério 6: resposta de período trocado ou de pedido velho é descartada', () => {
    assert.equal(respostaAtual({ pedido: 2, ultimo: 2, periodo: '90d', periodoAtual: '90d' }), true);
    assert.equal(respostaAtual({ pedido: 2, ultimo: 2, periodo: '90d', periodoAtual: '30d' }), false);
    assert.equal(respostaAtual({ pedido: 1, ultimo: 2, periodo: '90d', periodoAtual: '90d' }), false);
  });

  test('sem GitHub: um texto só, que diz como configurar', () => {
    assert.match(SEM_GITHUB.texto, /gh auth login/);
    assert.match(SEM_GITHUB.texto, /--sem-github/);
    assert.match(SEM_GITHUB.titulo, /sem o GitHub/);
  });
});

// O CSS de cada tela fica carregado quando se troca de tela: uma classe com o mesmo nome em duas
// telas desmonta a outra. Toda classe própria começa com `repo-`; as comuns são as da moldura e os
// selos de status.
describe('repos na /ui: as classes', () => {
  const SELOS = new Set(['badge', 'p', 'reason', 'soft', 'b-active', 'b-waiting', 'b-completed', 'b-error', 'b-abandoned']);
  const classesDoCss = (arquivo: string) => new Set([...readFileSync(`${PASTA_DA_UI}${arquivo}`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.([a-z][a-z0-9-]*)/g)].map((m) => m[1]!));
  const daMoldura = classesDoCss('shell.css');
  const permitida = (c: string) => c.startsWith('repo-') || SELOS.has(c) || daMoldura.has(c);

  test('toda classe de repos.css começa com repo-, é selo ou é da moldura', () => {
    assert.deepEqual([...classesDoCss('repos.css')].filter((c) => !permitida(c)), []);
  });

  test('repos.css não estiliza classe de outra tela, fora selos e moldura', () => {
    const minhas = new Set([...classesDoCss('repos.css')].filter((c) => !daMoldura.has(c)));
    const outras = [
      ...readdirSync(PASTA_DA_UI).filter((a) => a.endsWith('.css') && !['repos.css', 'shell.css', 'brand.css'].includes(a)),
      ...readdirSync(`${PASTA_DA_UI}screens`).filter((a) => a.endsWith('.css')).map((a) => `screens/${a}`),
    ];
    assert.ok(outras.includes('screens/session-detail.css'));
    for (const outra of outras) {
      assert.deepEqual([...classesDoCss(outra)].filter((c) => minhas.has(c) && !SELOS.has(c)), [], `repos.css e ${outra} estilizam as mesmas classes`);
    }
  });

  test('as telas só usam classe da moldura, selo ou repo-', () => {
    for (const arquivo of ['screens/repos.js', 'screens/repo.js']) {
      const fonte = readFileSync(`${PASTA_DA_UI}${arquivo}`, 'utf8');
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
