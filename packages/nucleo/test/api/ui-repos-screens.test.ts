// As telas Repositórios (C22, #104) e Repositório (C23, #105) montadas no DOM falso, com um `ctx.ler`
// falso que devolve respostas no formato de src/api/repos-tipos.ts (dados inventados).
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import type { ListaDeRepos, MetricasDoRepo, RepoDaLista } from '../../src/api/repos-tipos.ts';
import { ElementoFalso, instalarDomFalso, texto } from './dom-falso.ts';

instalarDomFalso();

// O que a tela Repositório usa do navegador além do DOM: a URL e o histórico.
const local = { pathname: '/ui/repos/exemplo-labs/vitrine-demo', search: '' };
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
const { mount: montarLista } = await import('../../ui/screens/repos.js');
// @ts-expect-error: idem
const { mount: montarRepo } = await import('../../ui/screens/repo.js');

const AGORA = Date.now();
const HORA = 3_600_000;
const iso = (msAtras: number) => new Date(AGORA - msAtras).toISOString();

// ---------- respostas de exemplo ----------

const repoDaLista = (owner: string, name: string, extra: Partial<RepoDaLista> = {}): RepoDaLista => ({
  owner,
  name,
  fullName: `${owner}/${name}`,
  url: `https://github.com/${owner}/${name}`,
  visibility: 'public',
  language: null,
  commits12: [],
  openIssues: 0,
  openPrs: 0,
  ci: null,
  sessions: { active: 0, needYou: 0, thisMonth: 0 },
  lastPush: null,
  ...extra,
});

function listaDeExemplo(): ListaDeRepos {
  return {
    state: 'ready',
    updatedAt: iso(0),
    error: null,
    account: 'dev-sintetico',
    summary: { organizations: 1, repositories: 3, withSessionsThisMonth: 1, openPrs: 4, prsAwaitingReview: 1, openIssues: 14, issuesClosedThisWeek: 2, ci: { greenRate: 0.9, runs: 20, days: 7 } },
    groups: [
      {
        owner: 'exemplo-labs',
        type: 'org',
        repos: [
          repoDaLista('exemplo-labs', 'vitrine-demo', {
            language: 'TypeScript',
            commits12: [1, 4, 2, 8, 5, 3, 9, 7, 6, 4, 10, 12],
            openIssues: 12,
            openPrs: 3,
            ci: 'ok',
            sessions: { active: 2, needYou: 1, thisMonth: 5 },
            lastPush: iso(2 * HORA + 60_000),
          }),
          repoDaLista('exemplo-labs', 'api-ficticia', { visibility: 'private', language: 'Python', openIssues: 2, openPrs: 1, ci: 'failed', lastPush: iso(30 * HORA) }),
        ],
      },
      { owner: 'dev-sintetico', type: 'personal', repos: [repoDaLista('dev-sintetico', 'dotfiles', { lastPush: iso(40 * 24 * HORA) })] },
    ],
  };
}

const amostra = (read: number, total: number) => ({ read, total, truncated: read < total });

function metricasDeExemplo(extra: Partial<MetricasDoRepo> = {}): MetricasDoRepo {
  return {
    state: 'ready',
    updatedAt: iso(0),
    error: null,
    computing: [],
    period: '90d',
    repo: {
      fullName: 'exemplo-labs/vitrine-demo',
      url: 'https://github.com/exemplo-labs/vitrine-demo',
      visibility: 'public',
      ci: 'ok',
      defaultBranch: 'main',
      stars: 7,
      forks: 1,
      watchers: 3,
      release: null,
      license: null,
    },
    tabs: { issues: 12, prs: 3, sessions: 5 },
    lines: { total: 48_300, inPeriod: 6_100 },
    commits: { total: 120, perWeek: 9, weeks: [5, 9, 12] },
    frequency: { weeks: [{ week: iso(14 * 24 * HORA), added: 900, removed: 200 }], added: 900, removed: 200 },
    issues: { byType: [{ type: 'Bug', closed: 4, open: 2 }], closed: 4, open: 2, medianTimeToCloseMs: 2 * HORA, sample: amostra(6, 6) },
    prs: {
      merged: 10,
      closedUnmerged: 1,
      open: 3,
      medianTimeToMergeMs: 3 * HORA,
      medianTimeToFirstReviewMs: HORA,
      medianSize: { added: 120, removed: 30 },
      reviewRounds: 1.4,
      agentShare: 0.6,
      sample: amostra(14, 14),
    },
    ci: { greenRate: 0.92, runs: 50, averageDurationMs: 6 * 60_000 },
    languages: [{ name: 'TypeScript', bytes: 9000, share: 0.9 }],
    contributors: [{ login: 'dev-sintetico', commits: 100, added: 5000, removed: 1200 }],
    releases: 2,
    releasesTotal: 5,
    community: 71,
    canWrite: false,
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
function mount(montarTela: (area: ElementoFalso, ctx: unknown) => Promise<() => void>, read: (rota: string) => Promise<unknown>, params = {}) {
  const area = new ElementoFalso('main');
  const leituras: string[] = [];
  const sinal = new AbortController();
  let limpar: (() => void) | null = null;
  const ctx = {
    params,
    signal: sinal.signal,
    read: (rota: string) => (leituras.push(rota), read(rota)),
    onChange: () => {},
    onRestart: () => {},
    liveState: () => 'live',
    counter: () => {},
    title: () => {},
    navigate: () => {},
  };
  const pronta = montarTela(area, ctx).then((f) => (limpar = f));
  const m: Montada = { area, leituras, sair: () => (sinal.abort(), limpar?.()) };
  abertas.push(m);
  return { ...m, pronta };
}

const montarListaCom = async (lista: ListaDeRepos) => {
  const m = mount(montarLista, async () => lista);
  await m.pronta;
  return m;
};

const montarRepoCom = async (dados: MetricasDoRepo) => {
  local.search = '';
  const m = mount(montarRepo, async () => dados, { owner: 'exemplo-labs', repo: 'vitrine-demo' });
  await m.pronta;
  return m;
};

const disparar = (no: ElementoFalso | null, tipo: string) => {
  assert.ok(no, `sem elemento para ${tipo}`);
  no.dispatchEvent({ type: tipo });
};
const gruposNaTela = (area: ElementoFalso) => area.querySelectorAll('.repo-group-head h2').map((h) => texto(h));
const reposNaTela = (area: ElementoFalso) => area.querySelectorAll('tr.repo-row').map((tr) => texto(tr.querySelector('.repo-name a')));

// ---------- Repositórios (C22) ----------

describe('Repositórios (C22) montada', () => {
  test('#104 critério 1: a lista agrupa por organização, com a conta pessoal como "você (pessoal)"', async () => {
    const { area, leituras } = await montarListaCom(listaDeExemplo());
    assert.deepEqual(leituras, ['/api/repos']);
    assert.deepEqual(gruposNaTela(area), ['exemplo-labs', 'você (pessoal)']);
    assert.deepEqual(reposNaTela(area), ['vitrine-demo', 'api-ficticia', 'dotfiles']);
    const contagens = area.querySelectorAll('.repo-group-head span').map((s) => texto(s));
    assert.deepEqual(contagens, ['2 repositórios', '1 repositório']);
  });

  test('#104 critério 1: o filtro de organização mostra só o grupo escolhido', async () => {
    const { area } = await montarListaCom(listaDeExemplo());
    const orgs = area.querySelector('select[aria-label="Organização"]')!;
    assert.deepEqual(orgs.querySelectorAll('option').map((o) => texto(o)), ['Todas as organizações', 'exemplo-labs', 'você (pessoal)']);
    orgs.value = 'dev-sintetico';
    disparar(orgs, 'change');
    assert.deepEqual(gruposNaTela(area), ['você (pessoal)']);
    assert.deepEqual(reposNaTela(area), ['dotfiles']);
    orgs.value = '';
    disparar(orgs, 'change');
    assert.deepEqual(reposNaTela(area), ['vitrine-demo', 'api-ficticia', 'dotfiles']);
  });

  test('#104 critério 1: a busca filtra pelo nome, sem caixa, e diz quando nada casa', async () => {
    const { area } = await montarListaCom(listaDeExemplo());
    const busca = area.querySelector('input[type="search"]')!;
    busca.value = 'FICTICIA';
    disparar(busca, 'input');
    assert.deepEqual(gruposNaTela(area), ['exemplo-labs']);
    assert.deepEqual(reposNaTela(area), ['api-ficticia']);
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
    assert.deepEqual(reposNaTela(area), ['api-ficticia']);
  });

  test('#104 critério 2: a linha mostra linguagem, issues, PRs, CI, sessões e último push', async () => {
    const { area } = await montarListaCom(listaDeExemplo());
    const tr = area.querySelectorAll('tr.repo-row')[0]!;
    const celulas = tr.children;
    assert.equal(celulas.length, 9);
    const [nome, linguagem, commits, issues, prs, ci, sessoes, push] = celulas;
    assert.equal(nome!.querySelector('a')!.getAttribute('href'), '/ui/repos/exemplo-labs/vitrine-demo');
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
    const tr = area.querySelectorAll('tr.repo-row').find((l) => texto(l.querySelector('.repo-name a')) === 'dotfiles')!;
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
    const { area } = await montarRepoCom(metricasDeExemplo({ canWrite: false }));
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
      metricasDeExemplo({ canWrite: true, traffic: { views: 340, uniques: 41, clones: 12, referrers: ['github.com'], days: 14 }, security: { dependabot: 2, codeScanning: null } }),
    );
    const t = texto(area);
    assert.match(t, /Tráfego e segurança/);
    assert.match(t, /Visitas 340 \(41 únicas\)/);
    assert.match(t, /Alertas do Dependabot 2/);
    assert.match(t, /Code scanning desligado/);
  });

  test('#105 critério 3: com amostra truncada, a nota diz sobre quantos itens o card foi calculado', async () => {
    const d = metricasDeExemplo();
    d.issues!.sample = amostra(100, 240);
    d.prs!.sample = amostra(100, 180);
    const { area } = await montarRepoCom(d);
    const notas = area.querySelectorAll('.repo-note').map((n) => texto(n));
    assert.ok(notas.includes('Por tipo sobre 100 de 240 issues lidas.'), notas.join(' | '));
    assert.ok(notas.includes('Medianas sobre 100 de 180 PRs lidos.'), notas.join(' | '));
  });

  test('#105 critério 3: com a amostra inteira, nenhuma nota de amostra', async () => {
    const { area } = await montarRepoCom(metricasDeExemplo());
    assert.deepEqual(area.querySelectorAll('.repo-note').map((n) => texto(n)).filter((n) => / sobre /.test(n)), []);
  });

  test('#105 critério 6: trocar o período relê com o novo periodo e descarta a resposta do período velho', async () => {
    local.search = '?period=90d';
    const pendentes = new Map<string, (d: MetricasDoRepo) => void>();
    const m = mount(
      montarRepo,
      (rota) => new Promise((resolver) => pendentes.set(new URLSearchParams(rota.split('?')[1]).get('period')!, resolver as (d: MetricasDoRepo) => void)),
      { owner: 'exemplo-labs', repo: 'vitrine-demo' },
    );
    assert.deepEqual(m.leituras, ['/api/repos/exemplo-labs/vitrine-demo?period=90d']);

    const botao = (rotulo: string) => m.area.querySelectorAll('.repo-seg button').find((b) => texto(b) === rotulo)!;
    botao('30 dias').click();
    assert.deepEqual(m.leituras.at(-1), '/api/repos/exemplo-labs/vitrine-demo?period=30d');
    assert.equal(local.search, '?period=30d');
    assert.equal(botao('30 dias').getAttribute('aria-pressed'), 'true');
    assert.equal(botao('90 dias').getAttribute('aria-pressed'), 'false');

    // A resposta do período velho chega depois da troca: a tela não a desenha.
    const velho = metricasDeExemplo({ period: '90d' });
    velho.commits!.total = 999;
    pendentes.get('90d')!(velho);
    await m.pronta;
    assert.doesNotMatch(texto(m.area), /999/);
    assert.match(texto(m.area), /Lendo 30 dias/);

    const novo = metricasDeExemplo({ period: '30d' });
    novo.commits!.total = 42;
    pendentes.get('30d')!(novo);
    await new Promise((r) => setImmediate(r));
    const commits = m.area.querySelectorAll('section.repo-stat').find((s) => texto(s.querySelector('.repo-stat-label')) === 'Commits')!;
    assert.equal(texto(commits.querySelector('.repo-stat-v')), '42');
    assert.match(texto(m.area), /\+6,1 mil em 30 dias/);
  });

  test('a aba Sessões leva à tela Sessões buscando o nome do repositório', async () => {
    const { area } = await montarRepoCom(metricasDeExemplo());
    const aba = area.querySelectorAll('nav.repo-tabs a').find((a) => texto(a).startsWith('Sessões'))!;
    assert.equal(texto(aba), 'Sessões (5)');
    assert.equal(aba.getAttribute('href'), '/ui/sessions?search=vitrine-demo');
  });

  test('a aba Métricas usa o ícone do Analytics', async () => {
    const { area } = await montarRepoCom(metricasDeExemplo());
    const atual = area.querySelector('nav.repo-tabs [aria-current="page"]')!;
    assert.equal(texto(atual), 'Métricas');
    assert.ok(atual.querySelector('svg')!.innerHTMLFalso.includes('M3 3v16a2 2 0 0 0 2 2h16'));
  });
});
