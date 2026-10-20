// O adaptador dos repositórios (#104 e #105) contra um `fetch` de mentira: ETag, 202, limite,
// recurso desligado, paginação com teto e as buscas que ele monta. Nada sai para a rede.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { RateLimitedError } from '../../src/github/cache.ts';
import { inicioDoPeriodo, issuesDoPeriodo, prsDoPeriodo, releasesDoPeriodo } from '../../src/github/repos-calculo.ts';
import { buscasDoDetalhe, buscasDoResumo, GithubReposSource, PAGINAS_DA_BUSCA, SemGithubError } from '../../src/github/repos-source.ts';

interface Pedido {
  url: string;
  headers: Headers;
  body: { query: string; variables: Record<string, unknown> } | null;
}

function fetchDe(responder: (p: Pedido) => Response) {
  const pedidos: Pedido[] = [];
  const f = (async (entrada: string | URL | Request, init?: RequestInit) => {
    const p = { url: String(entrada), headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : null };
    pedidos.push(p);
    return responder(p);
  }) as typeof fetch;
  return { f, pedidos };
}

const fonte = (f: typeof fetch) => new GithubReposSource({ token: 't', fetch: f, api: 'https://api.falso', url: 'https://api.falso/graphql' });

describe('#104 CA3 e #105: REST com ETag', () => {
  test('manda If-None-Match e devolve o ETag; 304 é "nao-modificado"', async () => {
    const { f, pedidos } = fetchDe((p) => (p.headers.get('if-none-match') === '"v1"' ? new Response(null, { status: 304 }) : Response.json([1], { headers: { etag: '"v1"' } })));
    const s = fonte(f);
    assert.deepEqual(await s.rest('/repos/a/b/languages', null), { estado: 'ok', valor: [1], etag: '"v1"' });
    assert.deepEqual(await s.rest('/repos/a/b/languages', '"v1"'), { estado: 'nao-modificado' });
    assert.equal(pedidos[0].url, 'https://api.falso/repos/a/b/languages');
    assert.equal(pedidos[0].headers.get('authorization'), 'bearer t');
  });

  test('202 é "calculando"; 204 é lista vazia', async () => {
    assert.deepEqual(await fonte(fetchDe(() => new Response('{}', { status: 202 })).f).rest('/repos/a/b/stats/contributors', null), { estado: 'calculando' });
    assert.deepEqual(await fonte(fetchDe(() => new Response(null, { status: 204 })).f).rest('/repos/a/b/stats/contributors', null), { estado: 'ok', valor: [], etag: null });
  });

  test('403 de limite vira RateLimitedError; 403 e 404 de recurso desligado viram "indisponivel"; 500 falha', async () => {
    const limite = fetchDe(() => Response.json({ message: 'API rate limit exceeded' }, { status: 403, headers: { 'retry-after': '7' } })).f;
    await assert.rejects(fonte(limite).rest('/repos/a/b/languages', null), (e) => e instanceof RateLimitedError && e.retryAfterMs === 7000);
    const desligado = fetchDe(() => Response.json({ message: 'Dependabot alerts are disabled' }, { status: 403 })).f;
    assert.deepEqual(await fonte(desligado).rest('/repos/a/b/dependabot/alerts', null), { estado: 'indisponivel', status: 403 });
    assert.deepEqual(await fonte(fetchDe(() => new Response('', { status: 404 })).f).rest('/repos/a/b/x', null), { estado: 'indisponivel', status: 404 });
    await assert.rejects(fonte(fetchDe(() => new Response('', { status: 500 })).f).rest('/repos/a/b/x', null), /500/);
  });

  test('caminho fora de /repos/<dono>/<repo>/ com o nome do GitHub: erro, sem chamar o GitHub', async () => {
    const { f, pedidos } = fetchDe(() => Response.json([]));
    for (const ruim of ['/user', '/repos/a/b', '/repos/-a/b/languages', '/repos/a/../languages', '/repos/a b/c/languages', '/repos/a/b%3Bc/languages']) {
      await assert.rejects(fonte(f).rest(ruim, null), /fora de/, ruim);
    }
    assert.equal(pedidos.length, 0);
    assert.equal((await fonte(f).rest('/repos/a/b.c_d-e/stats/contributors?x=1', null)).estado, 'ok');
  });

  test('pedido que nunca responde: estourado o teto, vira erro comum, no REST e no GraphQL', async () => {
    const sinais: AbortController[] = [];
    const tetos: number[] = [];
    // Nunca responde; só o sinal do pedido o encerra.
    const pendurado = (async (_: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_r, rej) => init?.signal?.addEventListener('abort', () => rej(init.signal!.reason)))) as typeof fetch;
    const s = new GithubReposSource({
      token: 't',
      fetch: pendurado,
      api: 'https://api.falso',
      url: 'https://api.falso/graphql',
      sinalDoPedido: (ms) => {
        tetos.push(ms);
        const c = new AbortController();
        sinais.push(c);
        return c.signal;
      },
    });
    const rest = s.rest('/repos/a/b/languages', null);
    const detalhe = s.detalhe('a', 'b', '2026-01-01');
    await new Promise((r) => setImmediate(r));
    assert.equal(sinais.length, 2);
    for (const c of sinais) c.abort(new DOMException('tempo', 'TimeoutError'));
    await assert.rejects(rest, (e: Error) => !(e instanceof RateLimitedError) && /não respondeu em 20 s/.test(e.message));
    await assert.rejects(detalhe, /não respondeu em 20 s/);
    assert.deepEqual(tetos, [20_000, 20_000]);
  });

  test('sem token do gh: SemGithubError, sem chamar o GitHub', async () => {
    const { f, pedidos } = fetchDe(() => Response.json({}));
    const s = new GithubReposSource({ token: () => Promise.reject(new Error('sem token')), fetch: f });
    await assert.rejects(s.rest('/repos/a/b/languages', null), SemGithubError);
    assert.equal(pedidos.length, 0);
  });
});

describe('#105: o detalhe pelo GraphQL', () => {
  test('as buscas do período e do resumo, com o repositório e os donos da conta', () => {
    assert.deepEqual(buscasDoDetalhe('org/repo', '2026-07-17'), {
      prs: 'repo:org/repo is:pr updated:>=2026-07-17 sort:updated-desc',
      fechadas: 'repo:org/repo is:issue is:closed closed:>=2026-07-17 sort:updated-desc',
      abertas: 'repo:org/repo is:issue is:open sort:updated-desc',
      mergeados: 'repo:org/repo is:pr is:merged merged:>=2026-07-17',
      fechadosSemMerge: 'repo:org/repo is:pr is:closed is:unmerged closed:>=2026-07-17',
    });
    assert.match(buscasDoResumo('eu', ['org-a'], '2026-10-08').review, /review:required.*user:eu org:org-a/);
  });

  test('repositório inexistente é `null`; as páginas seguintes vêm em série, até o teto', async () => {
    let paginas = 0;
    const pagina = (temMais: boolean) => ({ issueCount: 999, pageInfo: { hasNextPage: temMais, endCursor: 'c' }, nodes: [{ createdAt: 'x', issueType: null }] });
    const { f, pedidos } = fetchDe((p) => {
      const op = /query (\w+)/.exec(p.body!.query)![1];
      if (op === 'RepoDetalhe' && p.body!.variables.r === 'nada') return Response.json({ data: { repository: null, prs: pagina(false), fechadas: pagina(false), abertas: pagina(false), mergeados: pagina(false), fechadosSemMerge: pagina(false) }, errors: [{ type: 'NOT_FOUND', message: 'x' }] });
      if (op === 'RepoDetalhe') return Response.json({ data: { repository: { nameWithOwner: 'o/r' }, prs: pagina(false), fechadas: pagina(true), abertas: pagina(false), mergeados: pagina(false), fechadosSemMerge: pagina(false) } });
      paginas++;
      return Response.json({ data: { search: pagina(true) } });
    });
    const s = fonte(f);
    assert.equal(await s.detalhe('o', 'nada', '2026-01-01'), null);
    const d = await s.detalhe('o', 'r', '2026-01-01');
    assert.equal(d?.fechadas.length, PAGINAS_DA_BUSCA.fechadas);
    assert.equal(paginas, PAGINAS_DA_BUSCA.fechadas - 1);
    assert.ok(pedidos.every((p) => p.url === 'https://api.falso/graphql'));
  });

  test('os totais vêm do issueCount: com 999 contados e 5 lidos, o total diz 999 e a amostra diz truncado', async () => {
    const AGORA = Date.parse('2026-10-15T12:00:00Z');
    const desde = inicioDoPeriodo('90d', AGORA);
    const quando = new Date(AGORA - 3 * 24 * 3_600_000).toISOString();
    const cinco = <T>(no: T) => ({ issueCount: 999, pageInfo: { hasNextPage: false, endCursor: null }, nodes: Array.from({ length: 5 }, () => no) });
    const pr = { createdAt: quando, mergedAt: quando, closedAt: quando, state: 'MERGED', additions: 1, deletions: 1, headRefName: 'x', author: null, reviews: null, pedidosDeMudanca: null };
    const releases = { totalCount: 40, nodes: [{ publishedAt: quando }, { publishedAt: null }, { publishedAt: '2025-01-01T00:00:00Z' }] };
    const { f, pedidos } = fetchDe(() =>
      Response.json({
        data: {
          repository: { nameWithOwner: 'o/r', releases },
          prs: cinco(pr),
          fechadas: cinco({ createdAt: quando, closedAt: quando, issueType: null }),
          abertas: cinco({ issueType: { name: 'Bug' } }),
          mergeados: { issueCount: 999 },
          fechadosSemMerge: { issueCount: 999 },
        },
      }),
    );
    const d = await fonte(f).detalhe('o', 'r', '2026-07-17');
    assert.ok(d);
    assert.equal(pedidos.length, 1);
    assert.match(pedidos[0].body!.query, /mergeados: search/);
    assert.deepEqual(d.contagens, { fechadas: 999, abertas: 999, prs: 999, mergeados: 999, fechadosSemMerge: 999 });
    const issues = issuesDoPeriodo(d.fechadas, d.abertas, d.contagens);
    assert.deepEqual([issues.closed, issues.open], [999, 999]);
    assert.deepEqual(issues.sample, { read: 10, total: 1998, truncated: true });
    assert.equal(issues.byType.reduce((s, t) => s + t.closed + t.open, 0), 10);
    const prs = prsDoPeriodo(d.prs, 3, desde, d.contagens);
    assert.deepEqual([prs.merged, prs.closedUnmerged, prs.open], [999, 999, 3]);
    assert.deepEqual(prs.sample, { read: 5, total: 999, truncated: true });
    assert.equal(releasesDoPeriodo(d.repo, desde), 1);
  });
});
