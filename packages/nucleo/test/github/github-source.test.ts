import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { GithubGraphqlSource, MAX_SHALLOW_PAGES, RateLimitedError, type QueryCost } from '../../src/index.ts';
import { contarChecks, QUERIES } from '../../src/github/github-source.ts';
import { FILTER, k, recorded, replayFetch, REPO, type Recorded } from './helpers.ts';

const source = (fetch = replayFetch(), onCost?: (c: QueryCost) => void) => new GithubGraphqlSource({ token: 'token-de-teste', fetch, onCost });

describe('adaptador GraphQL com respostas gravadas', () => {
  test('leitura rasa: tipo, chave do pai e resumo das filhas, numa consulta', async () => {
    const fetch = replayFetch();
    const costs: QueryCost[] = [];
    const nodes = await source(fetch, (c) => costs.push(c)).listShallow(FILTER);
    assert.equal(fetch.calls.length, 1);
    assert.equal(fetch.calls[0].headers.authorization, 'bearer token-de-teste');
    assert.equal(nodes.length, 60);
    const ini = nodes.find((n) => n.number === 1)!;
    assert.deepEqual([ini.type, ini.parent, ini.progress?.total], ['Initiative', null, 9]);
    const epic = nodes.find((n) => n.number === 6)!;
    assert.deepEqual([epic.type, epic.parent], ['Epic', k(1)]);
    assert.deepEqual(nodes.find((n) => n.number === 41)?.parent, k(6));
    assert.deepEqual(costs, [{ operation: 'WorkShallow', cost: 1, remaining: 3794 }]);
  });

  test('filhas ao expandir, com PR, CI e review de cada uma', async () => {
    const { children, details } = await source().children(k(6));
    assert.deepEqual(children.map((c) => c.number).sort((a, b) => a - b), [40, 41, 42]);
    assert.ok(children.every((c) => c.parent === k(6)));
    const spike = details.find((d) => d.key === k(40))!;
    assert.deepEqual(spike.pullRequests.map((p) => [p.number, p.state]), [[67, 'MERGED']]);
    assert.equal(spike.stage, 'concluída');
  });

  test('detalhe de um card', async () => {
    const d = await source().detail(k(6));
    assert.deepEqual([d.key, d.state, d.stage], [k(6), 'OPEN', 'a fazer']);
  });

  test('pais por lote: a issue e os pais até a raiz, numa consulta; inexistente é ignorada', async () => {
    const fetch = replayFetch();
    const nodes = await source(fetch).nodes([k(40), k(99999)]);
    assert.equal(fetch.calls.length, 1);
    assert.deepEqual(nodes.map((n) => [n.number, n.type, n.parent]), [[40, 'Spike', k(6)], [6, 'Epic', k(1)], [1, 'Initiative', null]]);
  });

  test('custo das consultas gravadas: leitura inicial ≤ 2 pontos e nenhuma acima de 10 (decisão 0001)', () => {
    const cost = (op: string) => recorded.filter((r) => r.operation === op).map((r) => r.body.data!.rateLimit!.cost);
    assert.ok(cost('WorkShallow')[0] + cost('WorkNodes')[0] <= 2);
    for (const r of recorded) assert.ok(r.body.data!.rateLimit!.cost <= 10, `${r.operation} custou ${r.body.data!.rateLimit!.cost}`);
  });
});

describe('adaptador GraphQL: paginação e erros', () => {
  const page = (numbers: number[], next: string | null): Recorded['body'] => ({
    data: {
      rateLimit: { cost: 1 },
      search: {
        pageInfo: { hasNextPage: next !== null, endCursor: next },
        nodes: [
          ...numbers.map((n) => ({ number: n, title: `t${n}`, url: 'u', state: 'OPEN', updatedAt: '2026-10-18T10:00:00Z', repository: { nameWithOwner: REPO }, issueType: null, subIssuesSummary: { total: 0, completed: 0, percentCompleted: 0 }, parent: null })),
          {},
        ],
      },
    },
  });

  test('busca as páginas seguintes, em série, e ignora PRs da busca', async () => {
    const fetch = replayFetch([
      { operation: 'WorkShallow', variables: { q: FILTER, after: null }, status: 200, body: page([1, 2], 'c1') },
      { operation: 'WorkShallow', variables: { q: FILTER, after: 'c1' }, status: 200, body: page([3], null) },
    ]);
    const nodes = await source(fetch).listShallow(FILTER);
    assert.deepEqual(nodes.map((n) => n.number), [1, 2, 3]);
    assert.equal(nodes[0].progress, null);
    assert.equal(fetch.calls.length, 2);
  });

  test(`para em ${MAX_SHALLOW_PAGES} páginas`, async () => {
    let calls = 0;
    const fetch = (async () => {
      calls++;
      return new Response(JSON.stringify(page([calls], `c${calls}`)));
    }) as unknown as typeof globalThis.fetch;
    await new GithubGraphqlSource({ token: 't', fetch }).listShallow(FILTER);
    assert.equal(calls, MAX_SHALLOW_PAGES);
  });

  test('delta acrescenta updated:>= à busca', async () => {
    const fetch = replayFetch([{ operation: 'WorkShallow', variables: { q: `${FILTER} updated:>=2026-10-18T12:00:00Z`, after: null }, status: 200, body: page([], null) }]);
    assert.deepEqual(await source(fetch).listShallow(FILTER, Date.parse('2026-10-18T12:00:00.500Z')), []);
  });

  test('403 de limite secundário vira RateLimitedError com o retry-after', async () => {
    const fetch = (async () =>
      new Response(JSON.stringify({ message: 'You have exceeded a secondary rate limit' }), { status: 403, headers: { 'retry-after': '60' } })) as unknown as typeof globalThis.fetch;
    await assert.rejects(new GithubGraphqlSource({ token: 't', fetch }).detail(k(1)), (e) => e instanceof RateLimitedError && e.retryAfterMs === 60_000);
  });

  test('429 e erro RATE_LIMITED do GraphQL também', async () => {
    const r429 = (async () => new Response('', { status: 429 })) as unknown as typeof globalThis.fetch;
    await assert.rejects(new GithubGraphqlSource({ token: 't', fetch: r429 }).detail(k(1)), RateLimitedError);
    const gql = (async () => new Response(JSON.stringify({ errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] }))) as unknown as typeof globalThis.fetch;
    await assert.rejects(new GithubGraphqlSource({ token: 't', fetch: gql }).detail(k(1)), RateLimitedError);
  });

  test('outros erros passam a mensagem do GitHub', async () => {
    const unauthorized = (async () => new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 })) as unknown as typeof globalThis.fetch;
    await assert.rejects(new GithubGraphqlSource({ token: 't', fetch: unauthorized }).detail(k(1)), /401: Bad credentials/);
    const notFound = (async () => new Response(JSON.stringify({ data: { repository: { issue: null } }, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve' }] }))) as unknown as typeof globalThis.fetch;
    await assert.rejects(new GithubGraphqlSource({ token: 't', fetch: notFound }).detail(k(1)), /Could not resolve/);
  });

  test('#241/AC-3 a function token is asked on every request: the connection caches it, not the source', async () => {
    let asked = 0;
    const s = new GithubGraphqlSource({ token: async () => (asked++, 'x'), fetch: replayFetch() });
    await s.detail(k(6));
    await s.detail(k(6));
    assert.equal(asked, 2);
  });
});

describe('CI com contagem (#131)', () => {
  test('conta as checagens do último commit: passaram, falharam e rodando; sem checagem, null', () => {
    const runs = (xs: Record<string, number>) => Object.entries(xs).map(([state, count]) => ({ state, count }));
    assert.deepEqual(contarChecks({ totalCount: 6, checkRunCountsByState: runs({ SUCCESS: 5, SKIPPED: 1, FAILURE: 0 }), statusContextCountsByState: [] }), { total: 6, ok: 6, falhas: 0, rodando: 0 });
    assert.deepEqual(
      contarChecks({ totalCount: 7, checkRunCountsByState: runs({ SUCCESS: 2, FAILURE: 1, IN_PROGRESS: 3 }), statusContextCountsByState: runs({ ERROR: 1 }) }),
      { total: 7, ok: 2, falhas: 2, rodando: 3 },
    );
    assert.equal(contarChecks({ totalCount: 0 }), null);
    assert.equal(contarChecks(null), null);
  });

  test('a consulta dos PRs pede a contagem por estado, sem listar as checagens', () => {
    assert.match(QUERIES.detail, /statusCheckRollup \{ state contexts\(first: 1\) \{ totalCount checkRunCountsByState/);
  });
});
