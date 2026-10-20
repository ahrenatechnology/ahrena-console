// Repositórios (#104) e métricas de um repositório (#105) pelo serviço e pela rota, contra o GitHub
// falso (src/simulator/fake-github.ts): nenhuma chamada à API real e nenhum token lido. As sessões
// vêm do cenário P1 do simulador, pela mesma leitura do MCP.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Accounts, startLocalApi, MontadorDoPainel, type LocalApi } from '../../src/api/index.ts';
import { criarReposDoNucleo, criarRotaDosRepos, ReposDoGithub, TTL_DOS_REPOS, type ListaDeRepos, type MetricasDoRepo, type RepoDaLista } from '../../src/api/repos.ts';
import { SessoesPorRepo } from '../../src/api/repos-sessions.ts';
import { GithubCache, MemoryCacheStore } from '../../src/github/cache.ts';
import { GithubReposSource, type FonteDosRepos } from '../../src/github/repos-source.ts';
import { FleetReader } from '../../src/mcp/fleet.ts';
import { ChangeCursor, type RecordedChange } from '../../src/changes/cursor.ts';
import { createFakeGithub, demoGit, type FakeGithubData, type FakeRepo } from '../../src/simulator/fake-github.ts';
import { seedPanelScenario } from '../../src/simulator/panel.ts';

const T0 = Date.parse('2026-10-15T12:00:00Z');
const MIN = 60_000;

function dados(extra: Partial<Record<string, Partial<FakeRepo>>> = {}): FakeGithubData {
  const repos: FakeRepo[] = [
    { owner: 'org-a', name: 'motor-de-regras', isPrivate: true, language: 'TypeScript', permission: 'WRITE', pushMin: 5, issues: 4, prs: 2, ci: 'FAILURE', commitsPerWeek: 10, dependabot: 3, codeScanning: 1, releases: 7, release: { tag: 'v1.0.0', daysAgo: 2 }, stars: 4, license: 'MIT' },
    { owner: 'org-a', name: 'app-receitas', isPrivate: false, language: 'Kotlin', permission: 'READ', pushMin: 60, issues: 1, prs: 0, ci: 'PENDING', commitsPerWeek: 6 },
    { owner: 'org-b', name: 'antigo', isPrivate: true, language: 'Go', permission: 'WRITE', pushMin: 200 * 24 * 60, issues: 0, prs: 0, ci: null, commitsPerWeek: 2 },
    { owner: 'dev-sintetico', name: 'cli-de-notas', isPrivate: false, language: 'Rust', permission: 'ADMIN', pushMin: 30, issues: 2, prs: 1, ci: 'SUCCESS', commitsPerWeek: 4 },
  ];
  return {
    login: 'dev-sintetico',
    organizations: ['org-a', 'org-b'],
    awaitingReview: 3,
    closedThisWeek: 9,
    repos: repos.map((r) => ({ ...r, ...(extra[r.name] ?? {}) })),
  };
}

type Modo = 'ok' | 'falha' | 'pendurado' | 'limitado';

interface Montagem {
  repos: ReposDoGithub;
  chamadas: string[];
  status: number[];
  agendados: { ms: number; fn: () => void }[];
  mudancas: () => Promise<RecordedChange[]>;
  relogio: { agora: number };
  modo: { atual: Modo };
  /** Pedidos ao `fetch`, em qualquer modo, e o máximo de pedidos em voo ao mesmo tempo. */
  pedidos: { total: number; emVoo: number; maximoEmVoo: number };
  cache: GithubCache;
  logs: string[];
}

interface OpcoesDaMontagem {
  base?: FakeGithubData;
  fonteNula?: boolean;
  token?: () => Promise<string>;
  /** Atraso de cada resposta, em ms reais (para pedidos simultâneos ficarem visíveis). */
  atrasoMs?: number;
  fonte?: FonteDosRepos;
  /** O sinal do teto de cada pedido (o teste aborta na mão, sem esperar 20 s). */
  sinalDoPedido?: (ms: number) => AbortSignal;
}

async function montar({ base = dados(), fonteNula = false, token, atrasoMs = 0, fonte: fonteDada, sinalDoPedido }: OpcoesDaMontagem = {}): Promise<Montagem> {
  const relogio = { agora: T0 };
  const agora = () => relogio.agora;
  const gh = createFakeGithub(base, { now: agora });
  const modo = { atual: 'ok' as Modo };
  const status: number[] = [];
  const pedidos = { total: 0, emVoo: 0, maximoEmVoo: 0 };
  const fetch = (async (entrada: string | URL | Request, init?: RequestInit) => {
    pedidos.total++;
    pedidos.emVoo++;
    pedidos.maximoEmVoo = Math.max(pedidos.maximoEmVoo, pedidos.emVoo);
    try {
      if (atrasoMs > 0) await new Promise((r) => setTimeout(r, atrasoMs));
      // Nunca responde; só o sinal do pedido (o teto) o encerra.
      if (modo.atual === 'pendurado') return await new Promise<Response>((_r, rej) => init?.signal?.addEventListener('abort', () => rej(init.signal!.reason)));
      if (modo.atual === 'falha') throw new Error('rede fora');
      if (modo.atual === 'limitado') return Response.json({ message: 'API rate limit exceeded' }, { status: 429, headers: { 'retry-after': '120' } });
      const r = await gh.fetch(entrada, init);
      status.push(r.status);
      return r;
    } finally {
      pedidos.emVoo--;
    }
  }) as typeof globalThis.fetch;
  const fonte: FonteDosRepos | null = fonteNula
    ? null
    : (fonteDada ?? new GithubReposSource({ token: token ?? 'token-de-teste', fetch, now: agora, api: 'https://falso.invalid', url: 'https://falso.invalid/graphql', sinalDoPedido }));

  const storage = openSqliteStorage({ path: ':memory:' });
  // P1: motor-de-regras pede permissão (precisa de você), app-receitas foi interrompida (sua vez).
  await seedPanelScenario(storage, 'p1', T0);
  const frota = new FleetReader({ storage, accounts: new Accounts({ storage, file: null }), now: agora, timeZone: 'UTC' });
  const cursor = new ChangeCursor({ generation: 'g', batchMs: 0, minIntervalMs: 0 });
  const inicio = cursor.current;
  const sessoes = new SessoesPorRepo({ frota, git: demoGit(base), cacheMs: 0, aoDescobrir: () => cursor.record({ type: 'repos', key: 'list', sessionId: null, accountId: null }) });
  const agendados: Montagem['agendados'] = [];
  const cache = new GithubCache({ store: new MemoryCacheStore(), now: agora });
  const logs: string[] = [];
  const repos = new ReposDoGithub({
    fonte,
    cache,
    sessoes,
    mudancas: cursor,
    agora,
    agendar: (fn, ms) => agendados.push({ fn, ms }),
    log: (msg) => logs.push(msg),
  });
  return {
    repos,
    chamadas: gh.calls,
    status,
    agendados,
    relogio,
    modo,
    pedidos,
    cache,
    logs,
    mudancas: async () => (await cursor.wait(inicio, { timeoutMs: 0 })).changes,
  };
}

/** Pede, espera a montagem por trás e pede de novo (o que a tela faz ao receber a mudança). */
async function listaPronta(m: Montagem): Promise<ListaDeRepos> {
  await m.repos.lista();
  await m.repos.esperar();
  return m.repos.lista();
}

async function metricasProntas(m: Montagem, dono: string, nome: string, periodo?: '30d' | '90d' | '1y'): Promise<MetricasDoRepo> {
  await m.repos.metricas(dono, nome, periodo);
  await m.repos.esperar();
  return m.repos.metricas(dono, nome, periodo);
}

const linha = (l: ListaDeRepos, completo: string): RepoDaLista => {
  const r = l.groups.flatMap((g) => g.repos).find((x) => x.fullName === completo);
  assert.ok(r, `sem ${completo}`);
  return r;
};

/** Resolve em até `ms`, ou falha: prova que o pedido não esperou o GitHub. */
const semEsperar = <T>(p: Promise<T>, ms = 300): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('o pedido esperou o GitHub')), ms))]);

describe('#104 CA1: repositórios agrupados por organização e pela conta pessoal', () => {
  test('orgs primeiro, pela atividade; a conta pessoal por último; o login no topo', async () => {
    const m = await montar();
    const l = await listaPronta(m);
    assert.equal(l.state, 'ready');
    assert.equal(l.account, 'dev-sintetico');
    assert.deepEqual(l.groups.map((g) => [g.owner, g.type, g.repos.map((r) => r.name)]), [
      ['org-a', 'org', ['motor-de-regras', 'app-receitas']],
      ['org-b', 'org', ['antigo']],
      ['dev-sintetico', 'personal', ['cli-de-notas']],
    ]);
    // Visibilidade e dono vêm em cada linha: busca, filtros e ordenação ficam no cliente.
    assert.deepEqual(l.groups[0].repos.map((r) => [r.owner, r.visibility]), [['org-a', 'private'], ['org-a', 'public']]);
    assert.equal(l.summary.organizations, 2);
    assert.equal(l.summary.repositories, 4);
  });
});

describe('#104 CA2: o que cada linha mostra', () => {
  test('linguagem, 12 semanas de commits, issues, PRs, CI e último push', async () => {
    const m = await montar();
    const l = await listaPronta(m);
    const motor = linha(l, 'org-a/motor-de-regras');
    assert.equal(motor.language, 'TypeScript');
    assert.equal(motor.commits12.length, 12);
    assert.ok(motor.commits12.some((c) => c > 0));
    assert.deepEqual([motor.openIssues, motor.openPrs, motor.ci], [4, 2, 'failed']);
    assert.equal(motor.lastPush, new Date(T0 - 5 * MIN).toISOString());
    assert.equal(linha(l, 'org-a/app-receitas').ci, 'running');
    assert.equal(linha(l, 'dev-sintetico/cli-de-notas').ci, 'ok');
    // Sem push nas 12 semanas: sem commits e sem chamada.
    assert.deepEqual(linha(l, 'org-b/antigo').commits12, []);
    assert.equal(linha(l, 'org-b/antigo').ci, null);
    assert.ok(!m.chamadas.some((c) => c.includes('org-b/antigo')));
    assert.equal(l.summary.openPrs, 3);
    assert.equal(l.summary.openIssues, 7);
    assert.equal(l.summary.prsAwaitingReview, 3);
    assert.equal(l.summary.issuesClosedThisWeek, 9);
    assert.equal(l.summary.ci.days, 7);
    assert.ok(l.summary.ci.runs > 0 && l.summary.ci.greenRate !== null && l.summary.ci.greenRate > 0 && l.summary.ci.greenRate <= 1);
  });

  test('sessões ativas e as que precisam de você saem das sessões do núcleo, pelo critério do #140', async () => {
    const m = await montar();
    const l = await listaPronta(m);
    // motor-de-regras: viva, esperando permissão (precisa). app-receitas: viva, interrompida (sua vez, não conta).
    assert.deepEqual(linha(l, 'org-a/motor-de-regras').sessions, { active: 1, needYou: 1, thisMonth: 1 });
    assert.deepEqual(linha(l, 'org-a/app-receitas').sessions, { active: 1, needYou: 0, thisMonth: 1 });
    assert.deepEqual(linha(l, 'dev-sintetico/cli-de-notas').sessions, { active: 0, needYou: 0, thisMonth: 0 });
    assert.equal(l.summary.withSessionsThisMonth, 2);
    // A descoberta do repositório de um cwd novo avisa a tela.
    assert.ok((await m.mudancas()).some((x) => x.type === 'repos' && x.key === 'list'));
  });
});

describe('#104 CA3: consulta enxuta e cache da decisão 0001', () => {
  test('o pedido não espera o GitHub: sem cache, responde já com "carregando" e dispara a leitura', async () => {
    const m = await montar();
    m.modo.atual = 'pendurado';
    const l = await semEsperar(m.repos.lista());
    assert.equal(l.state, 'loading');
    assert.deepEqual(l.groups, []);
    const d = await semEsperar(m.repos.metricas('org-a', 'motor-de-regras'));
    assert.equal(d.state, 'loading');
    // Um segundo pedido também volta na hora e não dispara outra leitura.
    await semEsperar(m.repos.lista());
    assert.equal(m.repos.chamadas.fonte, 2);
  });

  test('uma ReposLista, um ReposResumo e, em série, commits e CI só dos repositórios recentes; dentro da validade, nenhuma chamada', async () => {
    const m = await montar();
    await listaPronta(m);
    const desde = new Date(T0 - 7 * 24 * 60 * MIN).toISOString().slice(0, 10);
    const runs = (r: string) => `GET /repos/${r}/actions/runs?created=%3E%3D${desde}&status=completed&per_page=100&exclude_pull_requests=true`;
    assert.deepEqual(m.chamadas, [
      'GRAPHQL ReposLista',
      'GRAPHQL ReposResumo',
      'GET /repos/org-a/motor-de-regras/stats/commit_activity',
      runs('org-a/motor-de-regras'),
      'GET /repos/dev-sintetico/cli-de-notas/stats/commit_activity',
      runs('dev-sintetico/cli-de-notas'),
      'GET /repos/org-a/app-receitas/stats/commit_activity',
      runs('org-a/app-receitas'),
    ]);
    const antes = m.chamadas.length;
    await m.repos.lista();
    await m.repos.esperar();
    assert.equal(m.chamadas.length, antes);
  });

  test('vencido o TTL, o REST vai com If-None-Match e o 304 mantém o dado', async () => {
    const m = await montar();
    const primeira = await listaPronta(m);
    m.relogio.agora += TTL_DOS_REPOS.estatisticas + MIN;
    m.status.length = 0;
    const segunda = await listaPronta(m);
    assert.ok(m.status.includes(304), `esperava 304 em ${m.status.join(',')}`);
    assert.deepEqual(linha(segunda, 'org-a/motor-de-regras').commits12, linha(primeira, 'org-a/motor-de-regras').commits12);
  });

  test('GitHub fora: serve o último dado com o motivo; sem dado nenhum, estado "erro"', async () => {
    const m = await montar();
    await listaPronta(m);
    m.modo.atual = 'falha';
    m.relogio.agora += TTL_DOS_REPOS.lista + MIN;
    const velha = await listaPronta(m);
    assert.equal(velha.state, 'ready');
    assert.match(velha.error ?? '', /rede fora/);
    assert.equal(velha.groups.length, 3);

    const vazia = await montar();
    vazia.modo.atual = 'falha';
    const l = await listaPronta(vazia);
    assert.equal(l.state, 'error');
    assert.match(l.error ?? '', /rede fora/);
  });

  test('#269 AC-3: a list cut by a page that kept failing is ready, and the error says how many came and why', async () => {
    class CutSource extends GithubReposSource {
      override async lista() {
        return { ...(await super.lista()), incomplete: { read: 4, total: 9, error: 'GitHub respondeu 502: HTTP 502' } };
      }
    }
    const gh = createFakeGithub(dados(), { now: () => T0 });
    const m = await montar({ fonte: new CutSource({ token: 'token-de-teste', fetch: gh.fetch, now: () => T0, api: 'https://falso.invalid', url: 'https://falso.invalid/graphql' }) });
    const l = await listaPronta(m);
    assert.equal(l.state, 'ready');
    assert.equal(l.groups.flatMap((g) => g.repos).length, 4);
    assert.equal(l.error, 'lista incompleta: 4 de 9 repositórios lidos, o resto falhou (GitHub respondeu 502: HTTP 502)');
  });

  test('#269: a cut list never replaces a longer one already shown; the old one stays, with the reason', async () => {
    const cut = { on: false };
    class CutSource extends GithubReposSource {
      override async lista() {
        const l = await super.lista();
        return cut.on ? { ...l, repos: l.repos.slice(0, 2), incomplete: { read: 2, total: 4, error: 'GitHub respondeu 502: HTTP 502' } } : l;
      }
    }
    const gh = createFakeGithub(dados(), { now: () => T0 });
    const m = await montar({ fonte: new CutSource({ token: 'token-de-teste', fetch: gh.fetch, now: () => m.relogio.agora, api: 'https://falso.invalid', url: 'https://falso.invalid/graphql' }) });
    assert.equal((await listaPronta(m)).summary.repositories, 4);
    cut.on = true;
    m.relogio.agora += TTL_DOS_REPOS.lista + MIN;
    const l = await listaPronta(m);
    assert.equal(l.state, 'ready');
    assert.equal(l.summary.repositories, 4);
    assert.match(l.error ?? '', /^lista incompleta: 2 de 4 repositórios lidos/);
  });

  test('sem GitHub (desligado ou sem token do gh): estado "sem-github"', async () => {
    const desligado = await montar({ fonteNula: true });
    assert.equal((await desligado.repos.lista()).state, 'no-github');
    assert.equal((await desligado.repos.metricas('org-a', 'x')).state, 'no-github');
    const semToken = await montar({ token: () => Promise.reject(new Error('sem token do GitHub: rode `gh auth login`')) });
    const l = await listaPronta(semToken);
    assert.equal(l.state, 'no-github');
  });

  test('o 202 só é tentado de novo enquanto alguém leu a resposta nos últimos 5 min; o próximo pedido retoma', async () => {
    const m = await montar({ base: dados({ 'motor-de-regras': { computeFirst: ['contributors'] } }) });
    const d = await metricasProntas(m, 'org-a', 'motor-de-regras');
    assert.deepEqual(d.computing, ['contributors']);
    assert.equal(m.agendados.length, 1);
    m.relogio.agora += 5 * MIN + 1;
    const antes = m.repos.chamadas.fonte;
    m.agendados[0].fn();
    await m.repos.esperar();
    assert.equal(m.repos.chamadas.fonte, antes, 'tentou de novo sem ninguém lendo');
    assert.equal(m.agendados.length, 1, 'agendou outra');
    // O próximo pedido acha a montagem vencida e retoma; o 202 já passou, e o campo vem.
    await m.repos.metricas('org-a', 'motor-de-regras');
    await m.repos.esperar();
    const depois = await m.repos.metricas('org-a', 'motor-de-regras');
    assert.ok(m.repos.chamadas.fonte > antes);
    assert.deepEqual(depois.computing, []);
    assert.ok(depois.contributors);
  });

  test('a pausa por limite passa pelo ReposDoGithub: depois do 429 nenhuma chamada sai até o retry-after, e o dado velho fica', async () => {
    const m = await montar();
    await listaPronta(m);
    m.relogio.agora += TTL_DOS_REPOS.estatisticas + MIN;
    m.modo.atual = 'limitado';
    const antes = m.pedidos.total;
    const limitada = await listaPronta(m);
    assert.equal(m.pedidos.total - antes, 1, 'só a primeira chamada sai; as outras param na pausa');
    assert.equal(limitada.state, 'ready');
    assert.match(limitada.error ?? '', /limitou/);
    assert.ok(m.cache.pauseLeftMs() > 0);
    // Vencida a resposta (60 s) e ainda na pausa (120 s): nada sai, mesmo com o GitHub de volta.
    m.modo.atual = 'ok';
    m.relogio.agora += 61_000;
    await listaPronta(m);
    assert.equal(m.pedidos.total - antes, 1);
    // Passada a pausa, volta a ler.
    m.relogio.agora += 60_000;
    const volta = await listaPronta(m);
    assert.ok(m.pedidos.total - antes > 1);
    assert.equal(volta.error, null);
  });

  test('a pausa de quem divide o cache (o trabalho, no núcleo) também segura os repositórios', async () => {
    const m = await montar();
    m.cache.pause(60_000);
    const l = await listaPronta(m);
    assert.equal(m.pedidos.total, 0);
    assert.equal(l.state, 'error');
    assert.match(l.error ?? '', /limitou/);
  });

  test('o GitHub ainda calcula (202): as 12 semanas ficam vazias e o núcleo tenta de novo em 3 s', async () => {
    const m = await montar({ base: dados({ 'motor-de-regras': { computeFirst: ['commit_activity'] } }) });
    const l = await listaPronta(m);
    assert.deepEqual(linha(l, 'org-a/motor-de-regras').commits12, []);
    assert.deepEqual(m.agendados.map((a) => a.ms), [3_000]);
    m.agendados[0].fn();
    await m.repos.esperar();
    const depois = await m.repos.lista();
    assert.equal(linha(depois, 'org-a/motor-de-regras').commits12.length, 12);
  });

  test('a leitura que muda a lista registra a mudança `repos`/`lista` no cursor', async () => {
    const m = await montar();
    await listaPronta(m);
    const repos = (await m.mudancas()).filter((x) => x.type === 'repos');
    assert.ok(repos.some((x) => x.key === 'list' && x.sessionId === null));
  });
});

describe('#105 CA1 a CA4: as métricas de um repositório', () => {
  test('linhas, commits, frequência, issues por tipo, PRs, CI, linguagens, contribuidores, releases e comunidade', async () => {
    const m = await montar();
    const d = await metricasProntas(m, 'org-a', 'motor-de-regras');
    assert.equal(d.state, 'ready');
    assert.deepEqual(d.computing, []);
    assert.equal(d.period, '90d');
    assert.equal(d.repo?.fullName, 'org-a/motor-de-regras');
    assert.deepEqual([d.repo?.visibility, d.repo?.ci, d.repo?.defaultBranch, d.repo?.license, d.repo?.release?.tag], ['private', 'failed', 'main', 'MIT', 'v1.0.0']);
    assert.deepEqual(d.tabs, { issues: 4, prs: 2, sessions: 1 });
    // CA1
    assert.ok(d.lines && d.lines.total > d.lines.inPeriod && d.lines.inPeriod > 0);
    assert.ok(d.commits && d.commits.total === d.commits.weeks.reduce((s, x) => s + x, 0) && d.commits.weeks.length >= 13);
    assert.ok(d.frequency && d.frequency.weeks.length === d.commits.weeks.length && d.frequency.added > 0);
    // CA2
    assert.ok(d.issues && d.issues.closed > 0 && d.issues.medianTimeToCloseMs !== null);
    assert.equal(d.issues.byType.reduce((s, t) => s + t.open, 0), 4);
    // CA3
    assert.ok(d.prs && d.prs.merged > 0 && d.prs.open === 2);
    assert.ok(d.prs.medianTimeToMergeMs !== null && d.prs.medianTimeToFirstReviewMs !== null && d.prs.medianSize !== null);
    assert.ok(d.prs.agentShare !== null && d.prs.agentShare > 0 && d.prs.agentShare < 1);
    // CA4
    assert.ok(d.ci && d.ci.runs > 0 && d.ci.greenRate !== null && d.ci.averageDurationMs !== null);
    assert.equal(d.languages?.[0].name, 'TypeScript');
    assert.ok(Math.abs((d.languages ?? []).reduce((s, l) => s + l.share, 0) - 1) < 0.01);
    assert.ok((d.contributors ?? []).length > 0);
    // Releases: as publicadas no período (90 dias: 2, 42 e 82 dias atrás) e o total desde sempre.
    assert.equal(d.releases, 3);
    assert.equal(d.releasesTotal, 7);
    // Os totais vêm do `issueCount`; aqui a amostra cobre tudo.
    assert.deepEqual([d.issues.sample.truncated, d.prs.sample.truncated], [false, false]);
    assert.equal(d.issues.open, 4);
    assert.equal(typeof d.community, 'number');
  });

  test('a leitura que muda as métricas registra `repos`/`<dono>/<repo>`, em minúsculas seja qual for a caixa da rota', async () => {
    const m = await montar();
    const d = await metricasProntas(m, 'Org-A', 'Motor-de-Regras');
    assert.equal(d.repo?.fullName, 'org-a/motor-de-regras');
    const chaves = (await m.mudancas()).filter((x) => x.type === 'repos').map((x) => x.key);
    assert.ok(chaves.includes('org-a/motor-de-regras'));
    assert.ok(!chaves.some((c) => c !== c.toLowerCase()), chaves.join(','));
    // A mesma entrada para as duas caixas: dentro da validade, nenhuma chamada nova.
    const antes = m.repos.chamadas.fonte;
    assert.equal((await m.repos.metricas('org-a', 'motor-de-regras')).state, 'ready');
    assert.equal(m.repos.chamadas.fonte, antes);
  });

  test('duas métricas pedidas juntas não têm chamadas ao GitHub sobrepostas (decisão 0001, item 6)', async () => {
    const m = await montar({ atrasoMs: 3 });
    await Promise.all([m.repos.metricas('org-a', 'motor-de-regras'), m.repos.metricas('dev-sintetico', 'cli-de-notas'), m.repos.lista()]);
    await m.repos.esperar();
    assert.ok(m.pedidos.total > 10, `só ${m.pedidos.total} pedidos`);
    assert.equal(m.pedidos.maximoEmVoo, 1);
    assert.equal((await m.repos.metricas('dev-sintetico', 'cli-de-notas')).state, 'ready');
  });

  test('um pedido pendurado não trava a fila: estourado o teto, vira `erro` e a próxima chamada sai', async () => {
    const tetos: AbortController[] = [];
    const m = await montar({
      sinalDoPedido: () => {
        const c = new AbortController();
        tetos.push(c);
        return c.signal;
      },
    });
    m.modo.atual = 'pendurado';
    await m.repos.lista();
    await m.repos.metricas('org-a', 'motor-de-regras');
    await new Promise((r) => setImmediate(r));
    // A ReposLista está pendurada; as métricas esperam na fila.
    assert.equal(m.pedidos.total, 1);
    m.modo.atual = 'ok';
    tetos[0].abort(new DOMException('tempo', 'TimeoutError'));
    await m.repos.esperar();
    const l = await m.repos.lista();
    assert.equal(l.state, 'error');
    assert.match(l.error ?? '', /não respondeu em 20 s/);
    const d = await m.repos.metricas('org-a', 'motor-de-regras');
    assert.equal(d.state, 'ready');
    assert.ok(m.pedidos.total > 1);
  });

  test('falha fora do previsto na montagem: vai para o log e para o `erro`, com estado "erro" sem dado anterior', async () => {
    const quebrada: FonteDosRepos = {
      lista: async () => ({ login: 'dev-sintetico', organizacoes: [], repos: null as never }),
      resumo: async () => ({ esperandoReview: 0, fechadasNaSemana: 0 }),
      detalhe: async () => ({ repo: null as never, prs: [], fechadas: [], abertas: [] }),
      rest: async () => ({ estado: 'indisponivel', status: 404 }),
    };
    const m = await montar({ fonte: quebrada });
    const l = await listaPronta(m);
    assert.equal(l.state, 'error');
    assert.match(l.error ?? '', /\w/);
    const d = await metricasProntas(m, 'org-a', 'motor-de-regras');
    assert.equal(d.state, 'error');
    assert.ok(d.error);
    assert.equal(m.logs.length, 2);
    assert.match(m.logs[0], /^repos: a montagem de list falhou: /);
    assert.match(m.logs[1], /^repos: a montagem de org-a\/motor-de-regras falhou: /);
    assert.ok((await m.mudancas()).some((x) => x.type === 'repos' && x.key === 'org-a/motor-de-regras'));
  });

  test('no máximo 50 combinações de repositório e período em memória: a lida há mais tempo sai', async () => {
    const m = await montar();
    await metricasProntas(m, 'org-a', 'motor-de-regras');
    for (let i = 0; i < 49; i++) await m.repos.metricas('org-a', `outro-${i}`);
    await m.repos.esperar();
    // 50 entradas: a primeira ainda está.
    assert.equal((await m.repos.metricas('org-a', 'motor-de-regras')).state, 'ready');
    // Lida agora, ela é a mais nova; a 51ª tira `outro-0`, e `outro-0` volta do zero.
    await m.repos.metricas('org-a', 'mais-um');
    await m.repos.esperar();
    assert.equal((await m.repos.metricas('org-a', 'motor-de-regras')).state, 'ready');
    assert.equal((await m.repos.metricas('org-a', 'outro-0')).state, 'loading');
    await m.repos.esperar();
  });

  test('estatística em 202: o campo vem nulo, o nome entra em `calculando`, e a nova tentativa preenche', async () => {
    const m = await montar({ base: dados({ 'motor-de-regras': { computeFirst: ['contributors', 'code_frequency'] } }) });
    const d = await metricasProntas(m, 'org-a', 'motor-de-regras');
    assert.deepEqual(d.computing, ['frequency', 'lines', 'contributors']);
    assert.equal(d.contributors, null);
    assert.equal(d.lines, null);
    assert.ok(d.commits !== null);
    assert.deepEqual(m.agendados.map((a) => a.ms), [3_000]);
    m.agendados[0].fn();
    await m.repos.esperar();
    const depois = await m.repos.metricas('org-a', 'motor-de-regras');
    assert.deepEqual(depois.computing, []);
    assert.ok(depois.contributors && depois.lines);
  });

  test('#269 AC-4: a PR sample cut by a page that kept failing still gives the metrics, and the error names the part', async () => {
    class CutSource extends GithubReposSource {
      override async detalhe(dono: string, nome: string, desde: string) {
        const d = await super.detalhe(dono, nome, desde);
        return d && { ...d, incomplete: ['amostra de PRs incompleta: 50 lidos, o resto falhou (GitHub respondeu 502: HTTP 502)'] };
      }
    }
    const gh = createFakeGithub(dados(), { now: () => T0 });
    const m = await montar({ fonte: new CutSource({ token: 'token-de-teste', fetch: gh.fetch, now: () => T0, api: 'https://falso.invalid', url: 'https://falso.invalid/graphql' }) });
    const r = await metricasProntas(m, 'org-a', 'motor-de-regras');
    assert.equal(r.state, 'ready');
    assert.ok(r.prs);
    assert.equal(r.error, 'amostra de PRs incompleta: 50 lidos, o resto falhou (GitHub respondeu 502: HTTP 502)');
  });

  test('repositório que não existe: "nao-encontrado"', async () => {
    const m = await montar();
    assert.equal((await metricasProntas(m, 'org-a', 'nao-existe')).state, 'not-found');
  });
});

describe('#105 CA5: tráfego e alertas só com escrita', () => {
  test('com escrita, tráfego, Dependabot e code scanning vêm', async () => {
    const m = await montar();
    const d = await metricasProntas(m, 'org-a', 'motor-de-regras');
    assert.equal(d.canWrite, true);
    assert.ok(d.traffic && d.traffic.views > 0 && d.traffic.days === 14 && d.traffic.referrers.length > 0);
    assert.deepEqual(d.security, { dependabot: 3, codeScanning: 1 });
  });

  test('sem escrita, as chaves não vêm e o núcleo nem chama esses endpoints', async () => {
    const m = await montar();
    const d = await metricasProntas(m, 'org-a', 'app-receitas');
    assert.equal(d.state, 'ready');
    assert.equal(d.canWrite, false);
    assert.ok(!('traffic' in d));
    assert.ok(!('security' in d));
    assert.ok(!JSON.stringify(d).includes('traffic'));
    assert.deepEqual(m.chamadas.filter((c) => /traffic|dependabot|code-scanning/.test(c)), []);
  });
});

describe('#105 CA6: o período vale para a tela inteira', () => {
  test('90 dias é o padrão; 30 dias e 1 ano mudam commits, linhas, PRs, issues, CI e contribuidores', async () => {
    const m = await montar();
    const padrao = await metricasProntas(m, 'org-a', 'motor-de-regras');
    const mes = await metricasProntas(m, 'org-a', 'motor-de-regras', '30d');
    const ano = await metricasProntas(m, 'org-a', 'motor-de-regras', '1y');
    assert.deepEqual([padrao.period, mes.period, ano.period], ['90d', '30d', '1y']);
    assert.ok(mes.commits!.weeks.length < padrao.commits!.weeks.length && padrao.commits!.weeks.length < ano.commits!.weeks.length);
    assert.ok(mes.commits!.total < ano.commits!.total);
    assert.ok(mes.lines!.inPeriod < ano.lines!.inPeriod);
    assert.equal(mes.lines!.total, ano.lines!.total);
    assert.ok(mes.prs!.merged < ano.prs!.merged);
    assert.ok(mes.issues!.closed < ano.issues!.closed);
    assert.ok(mes.ci!.runs < ano.ci!.runs);
    assert.deepEqual([mes.releases, padrao.releases, ano.releases], [1, 3, 7]);
    assert.deepEqual([mes.releasesTotal, ano.releasesTotal], [7, 7]);
    const commitsDe = (d: MetricasDoRepo) => d.contributors!.reduce((s, c) => s + c.commits, 0);
    assert.ok(commitsDe(mes) < commitsDe(ano));
    // As estatísticas do REST não dependem do período: trocar de período não as relê.
    assert.equal(m.chamadas.filter((c) => c.endsWith('/stats/commit_activity')).length, 1);
  });
});

describe('#104 e #105: a rota /api/repos no núcleo', () => {
  let api: LocalApi;
  let m: Montagem;
  before(async () => {
    m = await montar();
    const storage = openSqliteStorage({ path: ':memory:' });
    const montador = new MontadorDoPainel({ storage, contas: new Accounts({ storage, file: null }), desktop: null, trabalho: null });
    api = await startLocalApi({ panelBuilder: montador, hooks: { storage }, port: 0, log: () => {}, repos: criarRotaDosRepos(m.repos) });
  });
  after(() => api.close());

  const get = async (caminho: string) => {
    const r = await fetch(`${api.url}${caminho}`);
    return { status: r.status, corpo: (await r.json()) as Record<string, unknown> };
  };

  test('GET /api/repos e /api/repos/<dono>/<repo> respondem 200 com o contrato', async () => {
    const l = await get('/api/repos');
    assert.equal(l.status, 200);
    assert.ok(['loading', 'ready'].includes(l.corpo.state as string));
    const d = await get('/api/repos/org-a/motor-de-regras');
    assert.equal(d.status, 200);
    assert.equal(d.corpo.period, '90d');
    assert.equal((await get('/api/repos/org-a/motor-de-regras?periodo=1a')).corpo.period, '1y');
    // The year is `1y`; the old value `1a` is still accepted under either parameter name.
    assert.equal((await get('/api/repos/org-a/motor-de-regras?period=1y')).corpo.period, '1y');
    assert.equal((await get('/api/repos/org-a/motor-de-regras?period=1a')).corpo.period, '1y');
  });

  test('dono, repo e período fora do padrão dão 400, e nada do pedido chega ao GitHub', async () => {
    await m.repos.esperar();
    const antes = m.chamadas.length;
    // `..` nem chega: o URL do pedido já o resolve antes da rota.
    for (const ruim of ['-org/x', 'org-/x', 'a--b/x', 'org/a%20b', 'org/a%3Bb', 'a%2Fb/c', `${'a'.repeat(40)}/x`, `org/${'r'.repeat(101)}`, 'org/%E0%A4%A']) {
      assert.equal((await get(`/api/repos/${ruim}`)).status, 400, ruim);
    }
    const ruim = await get('/api/repos/org-a/motor-de-regras?periodo=2a');
    assert.equal(ruim.status, 400);
    assert.equal(ruim.corpo.error, 'period: um de 30d, 90d, 1y');
    assert.equal((await get('/api/repos/org-a/motor-de-regras/issues')).status, 404);
    await m.repos.esperar();
    assert.equal(m.chamadas.length, antes);
  });

  test('?atualizar=1 relê o GitHub, mas respeita o mínimo de 30 s entre releituras forçadas', async () => {
    await m.repos.esperar();
    await get('/api/repos');
    await m.repos.esperar();
    const listas = () => m.chamadas.filter((c) => c === 'GRAPHQL ReposLista').length;
    const antes = listas();
    m.relogio.agora += 10_000;
    await get('/api/repos?atualizar=1');
    await m.repos.esperar();
    assert.equal(listas(), antes, 'releu antes de 30 s');
    m.relogio.agora += 21_000;
    await get('/api/repos?atualizar=1');
    await m.repos.esperar();
    assert.equal(listas(), antes + 1);
  });

  test('só GET', async () => {
    const r = await fetch(`${api.url}/api/repos`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 405);
  });
});

describe('#104 e #105: o serviço como o núcleo monta', () => {
  test('criarReposDoNucleo({ demo: true }) não chama nenhum fetch fora do GitHub falso', async () => {
    const original = globalThis.fetch;
    const fora: string[] = [];
    globalThis.fetch = (async (entrada: string | URL | Request) => {
      fora.push(String(entrada));
      throw new Error('fetch de verdade na demo');
    }) as typeof fetch;
    try {
      const storage = openSqliteStorage({ path: ':memory:' });
      await seedPanelScenario(storage, 'p1', T0);
      const frota = new FleetReader({ storage, accounts: new Accounts({ storage, file: null }) });
      const logs: string[] = [];
      const { repos } = criarReposDoNucleo({
        demo: true,
        semGithub: false,
        cache: new GithubCache({ store: new MemoryCacheStore() }),
        frota,
        mudancas: new ChangeCursor(),
        log: (msg) => logs.push(msg),
      });
      await repos.lista();
      await repos.metricas('exemplo-labs', 'vitrine-demo');
      await repos.esperar();
      const l = await repos.lista();
      const d = await repos.metricas('exemplo-labs', 'vitrine-demo');
      assert.equal(l.state, 'ready');
      assert.equal(l.account, 'dev-sintetico');
      assert.equal(d.state, 'ready');
      assert.deepEqual(fora, []);
      assert.deepEqual(logs, []);
      await storage.close();
    } finally {
      globalThis.fetch = original;
    }
  });
});
