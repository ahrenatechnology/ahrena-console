// Repositórios (#104) e métricas de um repositório (#105) pelo serviço e pela rota, contra o GitHub
// falso (src/simulador/github-falso.ts): nenhuma chamada à API real e nenhum token lido. As sessões
// vêm do cenário P1 do simulador, pela mesma leitura do MCP.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Contas, iniciarApiLocal, MontadorDoPainel, type ApiLocal } from '../../src/api/index.ts';
import { criarRotaDosRepos, ReposDoGithub, TTL_DOS_REPOS, type ListaDeRepos, type MetricasDoRepo, type RepoDaLista } from '../../src/api/repos.ts';
import { SessoesPorRepo } from '../../src/api/repos-sessoes.ts';
import { GithubCache, MemoryCacheStore } from '../../src/github/cache.ts';
import { GithubReposSource, type FonteDosRepos } from '../../src/github/repos-source.ts';
import { LeituraDaFrota } from '../../src/mcp/frota.ts';
import { CursorDeMudancas, type MudancaRegistrada } from '../../src/mudancas/cursor.ts';
import { criarGithubFalso, gitDaDemo, type DadosDoGithubFalso, type RepoFalso } from '../../src/simulador/github-falso.ts';
import { semearCenariosDoPainel } from '../../src/simulador/painel.ts';

const T0 = Date.parse('2026-10-15T12:00:00Z');
const MIN = 60_000;

function dados(extra: Partial<Record<string, Partial<RepoFalso>>> = {}): DadosDoGithubFalso {
  const repos: RepoFalso[] = [
    { dono: 'org-a', nome: 'motor-de-regras', privado: true, linguagem: 'TypeScript', permissao: 'WRITE', pushMin: 5, issues: 4, prs: 2, ci: 'FAILURE', ritmo: 10, dependabot: 3, codeScanning: 1, releases: 7, release: { tag: 'v1.0.0', diasAtras: 2 }, estrelas: 4, licenca: 'MIT' },
    { dono: 'org-a', nome: 'app-receitas', privado: false, linguagem: 'Kotlin', permissao: 'READ', pushMin: 60, issues: 1, prs: 0, ci: 'PENDING', ritmo: 6 },
    { dono: 'org-b', nome: 'antigo', privado: true, linguagem: 'Go', permissao: 'WRITE', pushMin: 200 * 24 * 60, issues: 0, prs: 0, ci: null, ritmo: 2 },
    { dono: 'dev-sintetico', nome: 'cli-de-notas', privado: false, linguagem: 'Rust', permissao: 'ADMIN', pushMin: 30, issues: 2, prs: 1, ci: 'SUCCESS', ritmo: 4 },
  ];
  return {
    login: 'dev-sintetico',
    organizacoes: ['org-a', 'org-b'],
    esperandoReview: 3,
    fechadasNaSemana: 9,
    repos: repos.map((r) => ({ ...r, ...(extra[r.nome] ?? {}) })),
  };
}

type Modo = 'ok' | 'falha' | 'pendurado';

interface Montagem {
  repos: ReposDoGithub;
  chamadas: string[];
  status: number[];
  agendados: { ms: number; fn: () => void }[];
  mudancas: () => Promise<MudancaRegistrada[]>;
  relogio: { agora: number };
  modo: { atual: Modo };
}

async function montar({ base = dados(), fonteNula = false, token }: { base?: DadosDoGithubFalso; fonteNula?: boolean; token?: () => Promise<string> } = {}): Promise<Montagem> {
  const relogio = { agora: T0 };
  const agora = () => relogio.agora;
  const gh = criarGithubFalso(base, { agora });
  const modo = { atual: 'ok' as Modo };
  const status: number[] = [];
  const fetch = (async (entrada: string | URL | Request, init?: RequestInit) => {
    if (modo.atual === 'pendurado') return new Promise<Response>(() => {});
    if (modo.atual === 'falha') throw new Error('rede fora');
    const r = await gh.fetch(entrada, init);
    status.push(r.status);
    return r;
  }) as typeof globalThis.fetch;
  const fonte: FonteDosRepos | null = fonteNula
    ? null
    : new GithubReposSource({ token: token ?? 'token-de-teste', fetch, now: agora, api: 'https://falso.invalid', url: 'https://falso.invalid/graphql' });

  const storage = openSqliteStorage({ path: ':memory:' });
  // P1: motor-de-regras pede permissão (precisa de você), app-receitas foi interrompida (sua vez).
  await semearCenariosDoPainel(storage, 'p1', T0);
  const frota = new LeituraDaFrota({ storage, contas: new Contas({ storage, arquivo: null }), agora, fusoHorario: 'UTC' });
  const cursor = new CursorDeMudancas({ geracao: 'g', agruparMs: 0, intervaloMinimoMs: 0 });
  const inicio = cursor.atual;
  const sessoes = new SessoesPorRepo({ frota, git: gitDaDemo(base), cacheMs: 0, aoDescobrir: () => cursor.registrar({ tipo: 'repos', chave: 'lista', sessionId: null, accountId: null }) });
  const agendados: Montagem['agendados'] = [];
  const repos = new ReposDoGithub({
    fonte,
    cache: new GithubCache({ store: new MemoryCacheStore(), now: agora }),
    sessoes,
    mudancas: cursor,
    agora,
    agendar: (fn, ms) => agendados.push({ fn, ms }),
  });
  return {
    repos,
    chamadas: gh.chamadas,
    status,
    agendados,
    relogio,
    modo,
    mudancas: async () => (await cursor.aguardar(inicio, { timeoutMs: 0 })).mudancas,
  };
}

/** Pede, espera a montagem por trás e pede de novo (o que a tela faz ao receber a mudança). */
async function listaPronta(m: Montagem): Promise<ListaDeRepos> {
  await m.repos.lista();
  await m.repos.esperar();
  return m.repos.lista();
}

async function metricasProntas(m: Montagem, dono: string, nome: string, periodo?: '30d' | '90d' | '1a'): Promise<MetricasDoRepo> {
  await m.repos.metricas(dono, nome, periodo);
  await m.repos.esperar();
  return m.repos.metricas(dono, nome, periodo);
}

const linha = (l: ListaDeRepos, completo: string): RepoDaLista => {
  const r = l.grupos.flatMap((g) => g.repos).find((x) => x.completo === completo);
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
    assert.equal(l.estado, 'pronto');
    assert.equal(l.conta, 'dev-sintetico');
    assert.deepEqual(l.grupos.map((g) => [g.dono, g.tipo, g.repos.map((r) => r.nome)]), [
      ['org-a', 'org', ['motor-de-regras', 'app-receitas']],
      ['org-b', 'org', ['antigo']],
      ['dev-sintetico', 'pessoal', ['cli-de-notas']],
    ]);
    // Visibilidade e dono vêm em cada linha: busca, filtros e ordenação ficam no cliente.
    assert.deepEqual(l.grupos[0].repos.map((r) => [r.dono, r.visibilidade]), [['org-a', 'privado'], ['org-a', 'publico']]);
    assert.equal(l.resumo.organizacoes, 2);
    assert.equal(l.resumo.repositorios, 4);
  });
});

describe('#104 CA2: o que cada linha mostra', () => {
  test('linguagem, 12 semanas de commits, issues, PRs, CI e último push', async () => {
    const m = await montar();
    const l = await listaPronta(m);
    const motor = linha(l, 'org-a/motor-de-regras');
    assert.equal(motor.linguagem, 'TypeScript');
    assert.equal(motor.commits12.length, 12);
    assert.ok(motor.commits12.some((c) => c > 0));
    assert.deepEqual([motor.issuesAbertas, motor.prsAbertos, motor.ci], [4, 2, 'falhou']);
    assert.equal(motor.ultimoPush, new Date(T0 - 5 * MIN).toISOString());
    assert.equal(linha(l, 'org-a/app-receitas').ci, 'rodando');
    assert.equal(linha(l, 'dev-sintetico/cli-de-notas').ci, 'ok');
    // Sem push nas 12 semanas: sem commits e sem chamada.
    assert.deepEqual(linha(l, 'org-b/antigo').commits12, []);
    assert.equal(linha(l, 'org-b/antigo').ci, null);
    assert.ok(!m.chamadas.some((c) => c.includes('org-b/antigo')));
    assert.equal(l.resumo.prsAbertos, 3);
    assert.equal(l.resumo.issuesAbertas, 7);
    assert.equal(l.resumo.prsEsperandoReview, 3);
    assert.equal(l.resumo.issuesFechadasNaSemana, 9);
    assert.equal(l.resumo.ci.dias, 7);
    assert.ok(l.resumo.ci.execucoes > 0 && l.resumo.ci.taxaVerde !== null && l.resumo.ci.taxaVerde > 0 && l.resumo.ci.taxaVerde <= 1);
  });

  test('sessões ativas e as que precisam de você saem das sessões do núcleo, pelo critério do #140', async () => {
    const m = await montar();
    const l = await listaPronta(m);
    // motor-de-regras: viva, esperando permissão (precisa). app-receitas: viva, interrompida (sua vez, não conta).
    assert.deepEqual(linha(l, 'org-a/motor-de-regras').sessoes, { ativas: 1, precisam: 1, noMes: 1 });
    assert.deepEqual(linha(l, 'org-a/app-receitas').sessoes, { ativas: 1, precisam: 0, noMes: 1 });
    assert.deepEqual(linha(l, 'dev-sintetico/cli-de-notas').sessoes, { ativas: 0, precisam: 0, noMes: 0 });
    assert.equal(l.resumo.comSessoesNoMes, 2);
    // A descoberta do repositório de um cwd novo avisa a tela.
    assert.ok((await m.mudancas()).some((x) => x.tipo === 'repos' && x.chave === 'lista'));
  });
});

describe('#104 CA3: consulta enxuta e cache da decisão 0001', () => {
  test('o pedido não espera o GitHub: sem cache, responde já com "carregando" e dispara a leitura', async () => {
    const m = await montar();
    m.modo.atual = 'pendurado';
    const l = await semEsperar(m.repos.lista());
    assert.equal(l.estado, 'carregando');
    assert.deepEqual(l.grupos, []);
    const d = await semEsperar(m.repos.metricas('org-a', 'motor-de-regras'));
    assert.equal(d.estado, 'carregando');
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
    assert.equal(velha.estado, 'pronto');
    assert.match(velha.erro ?? '', /rede fora/);
    assert.equal(velha.grupos.length, 3);

    const vazia = await montar();
    vazia.modo.atual = 'falha';
    const l = await listaPronta(vazia);
    assert.equal(l.estado, 'erro');
    assert.match(l.erro ?? '', /rede fora/);
  });

  test('sem GitHub (desligado ou sem token do gh): estado "sem-github"', async () => {
    const desligado = await montar({ fonteNula: true });
    assert.equal((await desligado.repos.lista()).estado, 'sem-github');
    assert.equal((await desligado.repos.metricas('org-a', 'x')).estado, 'sem-github');
    const semToken = await montar({ token: () => Promise.reject(new Error('sem token do GitHub: rode `gh auth login`')) });
    const l = await listaPronta(semToken);
    assert.equal(l.estado, 'sem-github');
  });

  test('o GitHub ainda calcula (202): as 12 semanas ficam vazias e o núcleo tenta de novo em 3 s', async () => {
    const m = await montar({ base: dados({ 'motor-de-regras': { calcularPrimeiro: ['commit_activity'] } }) });
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
    const repos = (await m.mudancas()).filter((x) => x.tipo === 'repos');
    assert.ok(repos.some((x) => x.chave === 'lista' && x.sessionId === null));
  });
});

describe('#105 CA1 a CA4: as métricas de um repositório', () => {
  test('linhas, commits, frequência, issues por tipo, PRs, CI, linguagens, contribuidores, releases e comunidade', async () => {
    const m = await montar();
    const d = await metricasProntas(m, 'org-a', 'motor-de-regras');
    assert.equal(d.estado, 'pronto');
    assert.deepEqual(d.calculando, []);
    assert.equal(d.periodo, '90d');
    assert.equal(d.repo?.completo, 'org-a/motor-de-regras');
    assert.deepEqual([d.repo?.visibilidade, d.repo?.ci, d.repo?.branchPadrao, d.repo?.licenca, d.repo?.release?.tag], ['privado', 'falhou', 'main', 'MIT', 'v1.0.0']);
    assert.deepEqual(d.abas, { issues: 4, prs: 2, sessoes: 1 });
    // CA1
    assert.ok(d.linhas && d.linhas.total > d.linhas.noPeriodo && d.linhas.noPeriodo > 0);
    assert.ok(d.commits && d.commits.total === d.commits.semanas.reduce((s, x) => s + x, 0) && d.commits.semanas.length >= 13);
    assert.ok(d.frequencia && d.frequencia.semanas.length === d.commits.semanas.length && d.frequencia.adicionadas > 0);
    // CA2
    assert.ok(d.issues && d.issues.fechadas > 0 && d.issues.medianaAteFecharMs !== null);
    assert.equal(d.issues.porTipo.reduce((s, t) => s + t.abertas, 0), 4);
    // CA3
    assert.ok(d.prs && d.prs.mergeados > 0 && d.prs.abertos === 2);
    assert.ok(d.prs.medianaAteMergeMs !== null && d.prs.medianaAtePrimeiroReviewMs !== null && d.prs.tamanhoMediano !== null);
    assert.ok(d.prs.fatiaPorAgentes !== null && d.prs.fatiaPorAgentes > 0 && d.prs.fatiaPorAgentes < 1);
    // CA4
    assert.ok(d.ci && d.ci.execucoes > 0 && d.ci.taxaVerde !== null && d.ci.duracaoMediaMs !== null);
    assert.equal(d.linguagens?.[0].nome, 'TypeScript');
    assert.ok(Math.abs((d.linguagens ?? []).reduce((s, l) => s + l.fatia, 0) - 1) < 0.01);
    assert.ok((d.contribuidores ?? []).length > 0);
    assert.equal(d.releases, 7);
    assert.equal(typeof d.comunidade, 'number');
  });

  test('a leitura que muda as métricas registra `repos`/`<dono>/<repo>`', async () => {
    const m = await montar();
    await metricasProntas(m, 'org-a', 'motor-de-regras');
    assert.ok((await m.mudancas()).some((x) => x.tipo === 'repos' && x.chave === 'org-a/motor-de-regras'));
  });

  test('estatística em 202: o campo vem nulo, o nome entra em `calculando`, e a nova tentativa preenche', async () => {
    const m = await montar({ base: dados({ 'motor-de-regras': { calcularPrimeiro: ['contributors', 'code_frequency'] } }) });
    const d = await metricasProntas(m, 'org-a', 'motor-de-regras');
    assert.deepEqual(d.calculando, ['frequencia', 'linhas', 'contribuidores']);
    assert.equal(d.contribuidores, null);
    assert.equal(d.linhas, null);
    assert.ok(d.commits !== null);
    assert.deepEqual(m.agendados.map((a) => a.ms), [3_000]);
    m.agendados[0].fn();
    await m.repos.esperar();
    const depois = await m.repos.metricas('org-a', 'motor-de-regras');
    assert.deepEqual(depois.calculando, []);
    assert.ok(depois.contribuidores && depois.linhas);
  });

  test('repositório que não existe: "nao-encontrado"', async () => {
    const m = await montar();
    assert.equal((await metricasProntas(m, 'org-a', 'nao-existe')).estado, 'nao-encontrado');
  });
});

describe('#105 CA5: tráfego e alertas só com escrita', () => {
  test('com escrita, tráfego, Dependabot e code scanning vêm', async () => {
    const m = await montar();
    const d = await metricasProntas(m, 'org-a', 'motor-de-regras');
    assert.equal(d.escrita, true);
    assert.ok(d.trafego && d.trafego.visitas > 0 && d.trafego.dias === 14 && d.trafego.origens.length > 0);
    assert.deepEqual(d.seguranca, { dependabot: 3, codeScanning: 1 });
  });

  test('sem escrita, as chaves não vêm e o núcleo nem chama esses endpoints', async () => {
    const m = await montar();
    const d = await metricasProntas(m, 'org-a', 'app-receitas');
    assert.equal(d.estado, 'pronto');
    assert.equal(d.escrita, false);
    assert.ok(!('trafego' in d));
    assert.ok(!('seguranca' in d));
    assert.ok(!JSON.stringify(d).includes('trafego'));
    assert.deepEqual(m.chamadas.filter((c) => /traffic|dependabot|code-scanning/.test(c)), []);
  });
});

describe('#105 CA6: o período vale para a tela inteira', () => {
  test('90 dias é o padrão; 30 dias e 1 ano mudam commits, linhas, PRs, issues, CI e contribuidores', async () => {
    const m = await montar();
    const padrao = await metricasProntas(m, 'org-a', 'motor-de-regras');
    const mes = await metricasProntas(m, 'org-a', 'motor-de-regras', '30d');
    const ano = await metricasProntas(m, 'org-a', 'motor-de-regras', '1a');
    assert.deepEqual([padrao.periodo, mes.periodo, ano.periodo], ['90d', '30d', '1a']);
    assert.ok(mes.commits!.semanas.length < padrao.commits!.semanas.length && padrao.commits!.semanas.length < ano.commits!.semanas.length);
    assert.ok(mes.commits!.total < ano.commits!.total);
    assert.ok(mes.linhas!.noPeriodo < ano.linhas!.noPeriodo);
    assert.equal(mes.linhas!.total, ano.linhas!.total);
    assert.ok(mes.prs!.mergeados < ano.prs!.mergeados);
    assert.ok(mes.issues!.fechadas < ano.issues!.fechadas);
    assert.ok(mes.ci!.execucoes < ano.ci!.execucoes);
    const commitsDe = (d: MetricasDoRepo) => d.contribuidores!.reduce((s, c) => s + c.commits, 0);
    assert.ok(commitsDe(mes) < commitsDe(ano));
    // As estatísticas do REST não dependem do período: trocar de período não as relê.
    assert.equal(m.chamadas.filter((c) => c.endsWith('/stats/commit_activity')).length, 1);
  });
});

describe('#104 e #105: a rota /api/repos no núcleo', () => {
  let api: ApiLocal;
  let m: Montagem;
  before(async () => {
    m = await montar();
    const storage = openSqliteStorage({ path: ':memory:' });
    const montador = new MontadorDoPainel({ storage, contas: new Contas({ storage, arquivo: null }), desktop: null, trabalho: null });
    api = await iniciarApiLocal({ montador, hooks: { storage }, port: 0, log: () => {}, repos: criarRotaDosRepos(m.repos) });
  });
  after(() => api.close());

  const get = async (caminho: string) => {
    const r = await fetch(`${api.url}${caminho}`);
    return { status: r.status, corpo: (await r.json()) as Record<string, unknown> };
  };

  test('GET /api/repos e /api/repos/<dono>/<repo> respondem 200 com o contrato', async () => {
    const l = await get('/api/repos');
    assert.equal(l.status, 200);
    assert.ok(['carregando', 'pronto'].includes(l.corpo.estado as string));
    const d = await get('/api/repos/org-a/motor-de-regras');
    assert.equal(d.status, 200);
    assert.equal(d.corpo.periodo, '90d');
    assert.equal((await get('/api/repos/org-a/motor-de-regras?periodo=1a')).corpo.periodo, '1a');
  });

  test('dono, repo e período fora do padrão dão 400, e nada do pedido chega ao GitHub', async () => {
    const antes = m.chamadas.length;
    // `..` nem chega: o URL do pedido já o resolve antes da rota.
    for (const ruim of ['-org/x', 'org-/x', 'a--b/x', 'org/a%20b', 'org/a%3Bb', 'a%2Fb/c', `${'a'.repeat(40)}/x`, `org/${'r'.repeat(101)}`, 'org/%E0%A4%A']) {
      assert.equal((await get(`/api/repos/${ruim}`)).status, 400, ruim);
    }
    assert.equal((await get('/api/repos/org-a/motor-de-regras?periodo=2a')).status, 400);
    assert.equal((await get('/api/repos/org-a/motor-de-regras/issues')).status, 404);
    await m.repos.esperar();
    assert.ok(m.chamadas.slice(antes).every((c) => !/%20|%3B|--/.test(c)));
  });

  test('só GET', async () => {
    const r = await fetch(`${api.url}/api/repos`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 405);
  });
});
