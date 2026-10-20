// O adaptador dos repositórios (#104 e #105) contra um `fetch` de mentira: ETag, 202, limite,
// recurso desligado, paginação com teto e as buscas que ele monta. Nada sai para a rede.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { RateLimitedError } from '../../src/github/cache.ts';
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
    });
    assert.match(buscasDoResumo('eu', ['org-a'], '2026-10-08').review, /review:required.*user:eu org:org-a/);
  });

  test('repositório inexistente é `null`; as páginas seguintes vêm em série, até o teto', async () => {
    let paginas = 0;
    const pagina = (temMais: boolean) => ({ issueCount: 999, pageInfo: { hasNextPage: temMais, endCursor: 'c' }, nodes: [{ createdAt: 'x', issueType: null }] });
    const { f, pedidos } = fetchDe((p) => {
      const op = /query (\w+)/.exec(p.body!.query)![1];
      if (op === 'RepoDetalhe' && p.body!.variables.r === 'nada') return Response.json({ data: { repository: null, prs: pagina(false), fechadas: pagina(false), abertas: pagina(false) }, errors: [{ type: 'NOT_FOUND', message: 'x' }] });
      if (op === 'RepoDetalhe') return Response.json({ data: { repository: { nameWithOwner: 'o/r' }, prs: pagina(false), fechadas: pagina(true), abertas: pagina(false) } });
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
});
