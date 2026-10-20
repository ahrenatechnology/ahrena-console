// As telas Repositórios (C22, #104) e Repositório (C23, #105) montadas no DOM falso, com um `ctx.ler`
// falso que devolve respostas no formato de src/api/repos-tipos.ts (dados inventados).
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import type { ListaDeRepos, MetricasDoRepo, RepoDaLista } from '../../src/api/repos-tipos.ts';
import { ElementoFalso, instalarDomFalso, texto } from './dom-falso.ts';

instalarDomFalso();

// O que a tela Repositório usa do navegador além do DOM: a URL e o histórico.
const local = { pathname: '/ui/repos/ahrenatechnology/ahrena-console', search: '' };
Object.assign(globalThis, {
  location: local,
  history: {
    state: null,
    replaceState: (_estado: unknown, _t: string, url: string) => {
      const u = new URL(url, 'http://127.0.0.1');
      local.pathname = u.pathname;
      local.search = u.search;
    },
  },
  getSelection: () => ({ toString: () => '' }),
});

// @ts-expect-error: módulo do navegador, em JavaScript puro
const { montar: montarLista } = await import('../../ui/telas/repos.js');
// @ts-expect-error: idem
const { montar: montarRepo } = await import('../../ui/telas/repo.js');

const AGORA = Date.now();
const HORA = 3_600_000;
const iso = (msAtras: number) => new Date(AGORA - msAtras).toISOString();

// ---------- respostas de exemplo ----------

const repoDaLista = (dono: string, nome: string, extra: Partial<RepoDaLista> = {}): RepoDaLista => ({
  dono,
  nome,
  completo: `${dono}/${nome}`,
  url: `https://github.com/${dono}/${nome}`,
  visibilidade: 'publico',
  linguagem: null,
  commits12: [],
  issuesAbertas: 0,
  prsAbertos: 0,
  ci: null,
  sessoes: { ativas: 0, precisam: 0, noMes: 0 },
  ultimoPush: null,
  ...extra,
});

function listaDeExemplo(): ListaDeRepos {
  return {
    estado: 'pronto',
    atualizadoEm: iso(0),
    erro: null,
    conta: 'fseguim',
    resumo: { organizacoes: 1, repositorios: 3, comSessoesNoMes: 1, prsAbertos: 4, prsEsperandoReview: 1, issuesAbertas: 14, issuesFechadasNaSemana: 2, ci: { taxaVerde: 0.9, execucoes: 20, dias: 7 } },
    grupos: [
      {
        dono: 'ahrenatechnology',
        tipo: 'org',
        repos: [
          repoDaLista('ahrenatechnology', 'ahrena-console', {
            linguagem: 'TypeScript',
            commits12: [1, 4, 2, 8, 5, 3, 9, 7, 6, 4, 10, 12],
            issuesAbertas: 12,
            prsAbertos: 3,
            ci: 'ok',
            sessoes: { ativas: 2, precisam: 1, noMes: 5 },
            ultimoPush: iso(2 * HORA + 60_000),
          }),
          repoDaLista('ahrenatechnology', 'gabi-api', { visibilidade: 'privado', linguagem: 'Python', issuesAbertas: 2, prsAbertos: 1, ci: 'falhou', ultimoPush: iso(30 * HORA) }),
        ],
      },
      { dono: 'fseguim', tipo: 'pessoal', repos: [repoDaLista('fseguim', 'dotfiles', { ultimoPush: iso(40 * 24 * HORA) })] },
    ],
  };
}

const amostra = (lidos: number, total: number) => ({ lidos, total, truncado: lidos < total });

function metricasDeExemplo(extra: Partial<MetricasDoRepo> = {}): MetricasDoRepo {
  return {
    estado: 'pronto',
    atualizadoEm: iso(0),
    erro: null,
    calculando: [],
    periodo: '90d',
    repo: {
      completo: 'ahrenatechnology/ahrena-console',
      url: 'https://github.com/ahrenatechnology/ahrena-console',
      visibilidade: 'publico',
      ci: 'ok',
      branchPadrao: 'main',
      estrelas: 7,
      forks: 1,
      observadores: 3,
      release: null,
      licenca: null,
    },
    abas: { issues: 12, prs: 3, sessoes: 5 },
    linhas: { total: 48_300, noPeriodo: 6_100 },
    commits: { total: 120, porSemana: 9, semanas: [5, 9, 12] },
    frequencia: { semanas: [{ semana: iso(14 * 24 * HORA), adicionadas: 900, removidas: 200 }], adicionadas: 900, removidas: 200 },
    issues: { porTipo: [{ tipo: 'Bug', fechadas: 4, abertas: 2 }], fechadas: 4, abertas: 2, medianaAteFecharMs: 2 * HORA, amostra: amostra(6, 6) },
    prs: {
      mergeados: 10,
      fechadosSemMerge: 1,
      abertos: 3,
      medianaAteMergeMs: 3 * HORA,
      medianaAtePrimeiroReviewMs: HORA,
      tamanhoMediano: { adicionadas: 120, removidas: 30 },
      rodadasDeReview: 1.4,
      fatiaPorAgentes: 0.6,
      amostra: amostra(14, 14),
    },
    ci: { taxaVerde: 0.92, execucoes: 50, duracaoMediaMs: 6 * 60_000 },
    linguagens: [{ nome: 'TypeScript', bytes: 9000, fatia: 0.9 }],
    contribuidores: [{ login: 'fseguim', commits: 100, adicionadas: 5000, removidas: 1200 }],
    releases: 2,
    releasesNoTotal: 5,
    comunidade: 71,
    escrita: false,
    ...extra,
  };
}

// ---------- montar ----------

interface Montada {
  area: ElementoFalso;
  leituras: string[];
  sair: () => void;
}

const abertas: Montada[] = [];
afterEach(() => {
  for (const m of abertas.splice(0)) m.sair();
});

/** Monta a tela sem esperar a primeira leitura; `pronta` resolve quando `montar` termina. */
function montar(montarTela: (area: ElementoFalso, ctx: unknown) => Promise<() => void>, ler: (rota: string) => Promise<unknown>, params = {}) {
  const area = new ElementoFalso('main');
  const leituras: string[] = [];
  const sinal = new AbortController();
  let limpar: (() => void) | null = null;
  const ctx = {
    params,
    sinal: sinal.signal,
    ler: (rota: string) => (leituras.push(rota), ler(rota)),
    aoMudar: () => {},
    aoReiniciar: () => {},
    aoVivo: () => 'ao-vivo',
    contador: () => {},
    titulo: () => {},
    navegar: () => {},
  };
  const pronta = montarTela(area, ctx).then((f) => (limpar = f));
  const m: Montada = { area, leituras, sair: () => (sinal.abort(), limpar?.()) };
  abertas.push(m);
  return { ...m, pronta };
}

const montarListaCom = async (lista: ListaDeRepos) => {
  const m = montar(montarLista, async () => lista);
  await m.pronta;
  return m;
};

const montarRepoCom = async (dados: MetricasDoRepo) => {
  local.search = '';
  const m = montar(montarRepo, async () => dados, { dono: 'ahrenatechnology', repo: 'ahrena-console' });
  await m.pronta;
  return m;
};

const disparar = (no: ElementoFalso | null, tipo: string) => {
  assert.ok(no, `sem elemento para ${tipo}`);
  no.dispatchEvent({ type: tipo });
};
const gruposNaTela = (area: ElementoFalso) => area.querySelectorAll('.repo-grupo-cab h2').map((h) => texto(h));
const reposNaTela = (area: ElementoFalso) => area.querySelectorAll('tr.repo-linha').map((tr) => texto(tr.querySelector('.repo-nome a')));

// ---------- Repositórios (C22) ----------

describe('Repositórios (C22) montada', () => {
  test('#104 critério 1: a lista agrupa por organização, com a conta pessoal como "você (pessoal)"', async () => {
    const { area, leituras } = await montarListaCom(listaDeExemplo());
    assert.deepEqual(leituras, ['/api/repos']);
    assert.deepEqual(gruposNaTela(area), ['ahrenatechnology', 'você (pessoal)']);
    assert.deepEqual(reposNaTela(area), ['ahrena-console', 'gabi-api', 'dotfiles']);
    const contagens = area.querySelectorAll('.repo-grupo-cab span').map((s) => texto(s));
    assert.deepEqual(contagens, ['2 repositórios', '1 repositório']);
  });

  test('#104 critério 1: o filtro de organização mostra só o grupo escolhido', async () => {
    const { area } = await montarListaCom(listaDeExemplo());
    const orgs = area.querySelector('select[aria-label="Organização"]')!;
    assert.deepEqual(orgs.querySelectorAll('option').map((o) => texto(o)), ['Todas as organizações', 'ahrenatechnology', 'você (pessoal)']);
    orgs.value = 'fseguim';
    disparar(orgs, 'change');
    assert.deepEqual(gruposNaTela(area), ['você (pessoal)']);
    assert.deepEqual(reposNaTela(area), ['dotfiles']);
    orgs.value = '';
    disparar(orgs, 'change');
    assert.deepEqual(reposNaTela(area), ['ahrena-console', 'gabi-api', 'dotfiles']);
  });

  test('#104 critério 1: a busca filtra pelo nome, sem caixa, e diz quando nada casa', async () => {
    const { area } = await montarListaCom(listaDeExemplo());
    const busca = area.querySelector('input[type="search"]')!;
    busca.value = 'GABI';
    disparar(busca, 'input');
    assert.deepEqual(gruposNaTela(area), ['ahrenatechnology']);
    assert.deepEqual(reposNaTela(area), ['gabi-api']);
    busca.value = 'nada-assim';
    disparar(busca, 'input');
    assert.deepEqual(reposNaTela(area), []);
    assert.match(texto(area), /Nenhum repositório com esse filtro/);
  });

  test('#104 critério 1: a visibilidade "Privados" deixa só os privados', async () => {
    const { area } = await montarListaCom(listaDeExemplo());
    const privados = area.querySelectorAll('.repo-seg button').find((b) => texto(b) === 'Privados')!;
    privados.click();
    assert.equal(privados.getAttribute('aria-pressed'), 'true');
    assert.deepEqual(reposNaTela(area), ['gabi-api']);
  });

  test('#104 critério 2: a linha mostra linguagem, issues, PRs, CI, sessões e último push', async () => {
    const { area } = await montarListaCom(listaDeExemplo());
    const tr = area.querySelectorAll('tr.repo-linha')[0]!;
    const celulas = tr.children;
    assert.equal(celulas.length, 9);
    const [nome, linguagem, commits, issues, prs, ci, sessoes, push] = celulas;
    assert.equal(nome!.querySelector('a')!.getAttribute('href'), '/ui/repos/ahrenatechnology/ahrena-console');
    assert.equal(texto(linguagem!), 'TypeScript');
    assert.ok(commits!.querySelector('svg polyline'), 'a sparkline dos commits');
    assert.equal(texto(issues!), '12');
    assert.equal(texto(prs!), '3');
    assert.equal(texto(ci!), 'CI ✓ CI passou');
    assert.ok(ci!.querySelector('.b-completed'));
    assert.equal(texto(sessoes!), '2 sessões vivas 1 precisa de você');
    assert.equal(texto(push!), '2 h');
  });

  test('#104 critério 2: o que não veio sai como traço, sem número inventado', async () => {
    const { area } = await montarListaCom(listaDeExemplo());
    const tr = area.querySelectorAll('tr.repo-linha').find((l) => texto(l.querySelector('.repo-nome a')) === 'dotfiles')!;
    const [, linguagem, commits, , , ci, sessoes, push] = tr.children;
    assert.equal(texto(linguagem!), '—');
    assert.equal(texto(commits!), '—');
    assert.equal(texto(ci!), '—');
    assert.equal(texto(sessoes!), '—');
    assert.equal(texto(push!), '40 dias');
  });
});

// ---------- Repositório (C23) ----------

describe('Repositório (C23) montada', () => {
  test('#105 critério 5: sem escrita, Visitas e Dependabot não aparecem, e o card é "Comunidade"', async () => {
    const { area } = await montarRepoCom(metricasDeExemplo({ escrita: false }));
    const t = texto(area);
    assert.doesNotMatch(t, /Visitas/);
    assert.doesNotMatch(t, /Clones/);
    assert.doesNotMatch(t, /Dependabot/);
    assert.doesNotMatch(t, /Tráfego e segurança/);
    assert.ok(area.querySelectorAll('h2.repo-ttl').some((h) => texto(h) === 'Comunidade'));
    assert.match(t, /Saúde da comunidade 71%/);
  });

  test('#105 critério 5: com escrita, o card é "Tráfego e segurança", com Visitas e Dependabot', async () => {
    const { area } = await montarRepoCom(
      metricasDeExemplo({ escrita: true, trafego: { visitas: 340, unicas: 41, clones: 12, origens: ['github.com'], dias: 14 }, seguranca: { dependabot: 2, codeScanning: null } }),
    );
    const t = texto(area);
    assert.match(t, /Tráfego e segurança/);
    assert.match(t, /Visitas 340 \(41 únicas\)/);
    assert.match(t, /Alertas do Dependabot 2/);
    assert.match(t, /Code scanning desligado/);
  });

  test('#105 critério 3: com amostra truncada, a nota diz sobre quantos itens o card foi calculado', async () => {
    const d = metricasDeExemplo();
    d.issues!.amostra = amostra(100, 240);
    d.prs!.amostra = amostra(100, 180);
    const { area } = await montarRepoCom(d);
    const notas = area.querySelectorAll('.repo-nota').map((n) => texto(n));
    assert.ok(notas.includes('Por tipo sobre 100 de 240 issues lidas.'), notas.join(' | '));
    assert.ok(notas.includes('Medianas sobre 100 de 180 PRs lidos.'), notas.join(' | '));
  });

  test('#105 critério 3: com a amostra inteira, nenhuma nota de amostra', async () => {
    const { area } = await montarRepoCom(metricasDeExemplo());
    assert.deepEqual(area.querySelectorAll('.repo-nota').map((n) => texto(n)).filter((n) => / sobre /.test(n)), []);
  });

  test('#105 critério 6: trocar o período relê com o novo periodo e descarta a resposta do período velho', async () => {
    local.search = '?periodo=90d';
    const pendentes = new Map<string, (d: MetricasDoRepo) => void>();
    const m = montar(
      montarRepo,
      (rota) => new Promise((resolver) => pendentes.set(new URLSearchParams(rota.split('?')[1]).get('periodo')!, resolver as (d: MetricasDoRepo) => void)),
      { dono: 'ahrenatechnology', repo: 'ahrena-console' },
    );
    assert.deepEqual(m.leituras, ['/api/repos/ahrenatechnology/ahrena-console?periodo=90d']);

    const botao = (rotulo: string) => m.area.querySelectorAll('.repo-seg button').find((b) => texto(b) === rotulo)!;
    botao('30 dias').click();
    assert.deepEqual(m.leituras.at(-1), '/api/repos/ahrenatechnology/ahrena-console?periodo=30d');
    assert.equal(local.search, '?periodo=30d');
    assert.equal(botao('30 dias').getAttribute('aria-pressed'), 'true');
    assert.equal(botao('90 dias').getAttribute('aria-pressed'), 'false');

    // A resposta do período velho chega depois da troca: a tela não a desenha.
    const velho = metricasDeExemplo({ periodo: '90d' });
    velho.commits!.total = 999;
    pendentes.get('90d')!(velho);
    await m.pronta;
    assert.doesNotMatch(texto(m.area), /999/);
    assert.match(texto(m.area), /Lendo 30 dias/);

    const novo = metricasDeExemplo({ periodo: '30d' });
    novo.commits!.total = 42;
    pendentes.get('30d')!(novo);
    await new Promise((r) => setImmediate(r));
    const commits = m.area.querySelectorAll('section.repo-stat').find((s) => texto(s.querySelector('.repo-stat-rot')) === 'Commits')!;
    assert.equal(texto(commits.querySelector('.repo-stat-v')), '42');
    assert.match(texto(m.area), /\+6,1 mil em 30 dias/);
  });

  test('a aba Sessões leva à tela Sessões buscando o nome do repositório', async () => {
    const { area } = await montarRepoCom(metricasDeExemplo());
    const aba = area.querySelectorAll('nav.repo-abas a').find((a) => texto(a).startsWith('Sessões'))!;
    assert.equal(texto(aba), 'Sessões (5)');
    assert.equal(aba.getAttribute('href'), '/ui/sessoes?busca=ahrena-console');
  });

  test('a aba Métricas usa o ícone do Analytics', async () => {
    const { area } = await montarRepoCom(metricasDeExemplo());
    const atual = area.querySelector('nav.repo-abas [aria-current="page"]')!;
    assert.equal(texto(atual), 'Métricas');
    assert.ok(atual.querySelector('svg')!.innerHTMLFalso.includes('M3 3v16a2 2 0 0 0 2 2h16'));
  });
});
