// #269: GitHub's GraphQL gives up on a query after ~10 s and answers 502. A fake GitHub here answers
// 502 to any page bigger than a limit, the way the real one did for 100 repositories with counts and
// CI. Nothing goes to the network and no token is read.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { RateLimitedError } from '../../src/github/cache.ts';
import { GithubDevConsoleSource } from '../../src/dev-console/source.ts';
import { GithubGatewayError, GithubGraphqlSource, retryOnGateway } from '../../src/github/github-source.ts';
import { GithubReposSource, LIST_PAGE_SIZE, MIN_PAGE_SIZE, PR_PAGE_SIZE } from '../../src/github/repos-source.ts';

interface Call {
  operation: string;
  variables: Record<string, unknown>;
}

const repo = (i: number) => ({
  name: `repo-${i}`,
  nameWithOwner: `org-${i % 3}/repo-${i}`,
  url: `https://example.invalid/org-${i % 3}/repo-${i}`,
  isPrivate: false,
  pushedAt: '2026-10-01T00:00:00Z',
  viewerPermission: 'READ',
  owner: { login: `org-${i % 3}`, __typename: 'Organization' },
  primaryLanguage: null,
  issues: { totalCount: 0 },
  pullRequests: { totalCount: 0 },
  defaultBranchRef: null,
});

const pr = { createdAt: '2026-10-01T00:00:00Z', mergedAt: null, closedAt: null, state: 'OPEN', additions: 1, deletions: 1, headRefName: 'x', author: null, reviews: null, pedidosDeMudanca: null };
const gateway = () => new Response('<html>502</html>', { status: 502 });

/**
 * A fake GraphQL endpoint: `ReposLista` over `repos` repositories and `RepoBusca` over `prs` PRs,
 * paged by the `$first` and `$after` they get; a page bigger than `maxPage` answers 502, and so
 * does every page `fails(call)` picks.
 */
function fakeGithub({ repos = 0, prs = 0, maxPage = Infinity, fails = (_: Call) => false }: { repos?: number; prs?: number; maxPage?: number; fails?: (c: Call) => boolean }) {
  const calls: Call[] = [];
  const all = Array.from({ length: repos }, (_, i) => repo(i));
  const slice = <T>(items: T[], v: Record<string, unknown>) => {
    const start = v.after ? Number(v.after) : 0;
    const end = start + Number(v.first);
    return { items: items.slice(start, end), pageInfo: { hasNextPage: end < items.length, endCursor: String(end) } };
  };
  const fetch = (async (_: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init!.body)) as { query: string; variables: Record<string, unknown> };
    const call = { operation: /query (\w+)/.exec(body.query)![1], variables: body.variables };
    calls.push(call);
    if (Number(call.variables.first) > maxPage || fails(call)) return gateway();
    const rateLimit = { cost: 1, remaining: 4999 };
    if (call.operation === 'ReposLista') {
      const p = slice(all, call.variables);
      return Response.json({ data: { rateLimit, viewer: { login: 'someone', organizations: { nodes: [{ login: 'org-0' }] }, repositories: { totalCount: repos, pageInfo: p.pageInfo, nodes: p.items } } } });
    }
    const prPages = slice(Array.from({ length: prs }, () => pr), call.variables);
    const prPage = { issueCount: prs, pageInfo: prPages.pageInfo, nodes: prPages.items };
    if (call.operation === 'RepoBusca') return Response.json({ data: { rateLimit, search: prPage } });
    if (call.operation === 'RepoDetalhe') {
      const none = { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };
      return Response.json({ data: { rateLimit, repository: { nameWithOwner: 'org-0/repo-0', releases: { totalCount: 0, nodes: [] } }, prs: prPage, fechadas: none, abertas: none, mergeados: { issueCount: 0 }, fechadosSemMerge: { issueCount: 0 } } });
    }
    throw new Error(`unexpected ${call.operation}`);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function source(fetch: typeof globalThis.fetch) {
  const sleeps: number[] = [];
  const s = new GithubReposSource({ token: 't', fetch, url: 'https://example.invalid/graphql', sleep: async (ms) => void sleeps.push(ms) });
  return { s, sleeps };
}

const pages = (calls: Call[], operation: string) => calls.filter((c) => c.operation === operation).map((c) => c.variables.first);

describe('#269 AC-1: the repository list in pages GitHub answers in time', () => {
  test('237 repositories against a GitHub that answers 502 above 25 per page: the whole list, no retry', async () => {
    const gh = fakeGithub({ repos: 237, maxPage: 25 });
    const { s, sleeps } = source(gh.fetch);
    const list = await s.lista();
    assert.equal(list.repos.length, 237);
    assert.equal(list.incomplete, undefined);
    assert.equal(new Set(list.repos.map((r) => r.nameWithOwner)).size, 237);
    assert.ok(pages(gh.calls, 'ReposLista').every((first) => first === LIST_PAGE_SIZE));
    assert.deepEqual(sleeps, []);
  });

  test('a GitHub that only answers 10 per page: the page halves on each 502 and stays small for the rest', async () => {
    const gh = fakeGithub({ repos: 40, maxPage: 10 });
    const { s, sleeps } = source(gh.fetch);
    const list = await s.lista();
    assert.equal(list.repos.length, 40);
    // 25 → 502, 12 → 502, 6 → answers; the next pages ask for 6.
    assert.deepEqual(pages(gh.calls, 'ReposLista').slice(0, 4), [25, 12, 6, 6]);
    assert.deepEqual(sleeps, [1_000, 3_000]);
  });

  test('a page already shrunk to 6 that fails again asks for the minimum, never less', async () => {
    const gh = fakeGithub({ repos: 20, maxPage: 6, fails: (c) => c.variables.after !== null });
    const { s } = source(gh.fetch);
    const list = await s.lista();
    assert.equal(list.repos.length, 6);
    // First page: 25 → 12 → 6 answers. Second: 6 → 3 and 1 would go below the floor, so 5 and 5.
    assert.deepEqual(pages(gh.calls, 'ReposLista'), [25, 12, 6, 6, MIN_PAGE_SIZE, MIN_PAGE_SIZE]);
  });
});

describe('#269 AC-3: a page that keeps failing leaves what was read', () => {
  test('the second page answers 502 every time: the first 25 come, and `incomplete` says 25 of 60 and why', async () => {
    const gh = fakeGithub({ repos: 60, fails: (c) => c.operation === 'ReposLista' && c.variables.after !== null });
    const { s, sleeps } = source(gh.fetch);
    const list = await s.lista();
    assert.equal(list.repos.length, 25);
    assert.equal(list.login, 'someone');
    assert.deepEqual({ ...list.incomplete, error: undefined }, { read: 25, total: 60, error: undefined });
    assert.match(list.incomplete!.error, /GitHub respondeu 502/);
    // The failing page was tried three times before giving up.
    assert.equal(gh.calls.length, 1 + 3);
    assert.deepEqual(sleeps, [1_000, 3_000]);
  });

  test('the first page failing every time is no list at all: the 502 goes up', async () => {
    const gh = fakeGithub({ repos: 60, fails: () => true });
    const { s } = source(gh.fetch);
    await assert.rejects(s.lista(), (e) => e instanceof GithubGatewayError && e.status === 502);
    assert.equal(gh.calls.length, 3);
  });

  test('a rate limit on a later page is not a partial list: it goes up for the cache to pause', async () => {
    let n = 0;
    const gh = fakeGithub({ repos: 60 });
    const limited = (async (input: string | URL | Request, init?: RequestInit) =>
      ++n === 2 ? Response.json({ message: 'API rate limit exceeded' }, { status: 429, headers: { 'retry-after': '5' } }) : gh.fetch(input, init)) as typeof globalThis.fetch;
    await assert.rejects(source(limited).s.lista(), RateLimitedError);
  });
});

describe('#269 AC-4: the repository metrics in PR pages GitHub answers in time', () => {
  test('120 PRs against a GitHub that answers 502 above 25 per page: the whole sample, 25 at a time', async () => {
    const gh = fakeGithub({ prs: 120, maxPage: PR_PAGE_SIZE });
    const { s, sleeps } = source(gh.fetch);
    const d = await s.detalhe('org-0', 'repo-0', '2026-01-01');
    assert.equal(d?.prs.length, 120);
    assert.equal(d?.incomplete, undefined);
    assert.deepEqual(pages(gh.calls, 'RepoDetalhe'), [PR_PAGE_SIZE]);
    assert.ok(pages(gh.calls, 'RepoBusca').every((first) => first === PR_PAGE_SIZE));
    assert.deepEqual(sleeps, []);
  });

  test('a later PR page that keeps failing: the sample read so far stays, and `incomplete` names the PRs', async () => {
    const gh = fakeGithub({ prs: 120, fails: (c) => c.operation === 'RepoBusca' && c.variables.after === '50' });
    const { s } = source(gh.fetch);
    const d = await s.detalhe('org-0', 'repo-0', '2026-01-01');
    assert.equal(d?.prs.length, 50);
    assert.equal(d?.contagens?.prs, 120);
    assert.equal(d?.incomplete?.length, 1);
    assert.match(d!.incomplete![0], /^amostra de PRs incompleta: 50 lidos, o resto falhou \(GitHub respondeu 502/);
  });
});

describe('#269 AC-2: retrying 502/503/504 reads, and only those', () => {
  test('retryOnGateway repeats a 502, 503 or 504 with growing waits, and nothing else', async () => {
    for (const status of [502, 503, 504]) {
      const sleeps: number[] = [];
      let n = 0;
      const v = await retryOnGateway(async () => {
        if (n++ < 2) throw new GithubGatewayError(`GitHub respondeu ${status}`, status);
        return 'ok';
      }, { sleep: async (ms) => void sleeps.push(ms) });
      assert.equal(v, 'ok');
      assert.deepEqual(sleeps, [1_000, 3_000]);
    }
    let tries = 0;
    await assert.rejects(
      retryOnGateway(async () => {
        tries++;
        throw new Error('GitHub respondeu 500: boom');
      }, { sleep: async () => {} }),
      /500/,
    );
    assert.equal(tries, 1);
  });

  test('a mutation through the transport is sent once, even on a 502: GitHub may have applied it', async () => {
    let n = 0;
    const fetch = (async () => (n++, gateway())) as typeof globalThis.fetch;
    const { s, sleeps } = source(fetch);
    await assert.rejects(s.query('OpenInstallPullRequest', 'mutation OpenInstallPullRequest { x }', {}), GithubGatewayError);
    assert.equal(n, 1);
    assert.deepEqual(sleeps, []);
    await assert.rejects(s.query('RepoBlobs', 'query RepoBlobs { x }', {}), GithubGatewayError);
    assert.equal(n, 1 + 3);
  });

  test('the Dev Console source retries a 502 on its reads', async () => {
    let n = 0;
    const fetch = (async () => {
      if (n++ === 0) return gateway();
      return Response.json({ data: { rateLimit: { cost: 1, remaining: 1 }, repository: { refs: { totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ name: 'main' }] } } } });
    }) as typeof globalThis.fetch;
    const sleeps: number[] = [];
    const s = new GithubDevConsoleSource({ token: 't', fetch, url: 'https://example.invalid/graphql', sleep: async (ms) => void sleeps.push(ms) });
    assert.deepEqual((await s.branches('org-0/repo-0')).names, ['main']);
    assert.equal(n, 2);
    assert.deepEqual(sleeps, [1_000]);
  });

  test('the work source (Kanban) retries a 502 on its reads', async () => {
    let n = 0;
    const fetch = (async () => {
      if (n++ === 0) return gateway();
      return Response.json({ data: { rateLimit: { cost: 1, remaining: 1 }, search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } });
    }) as typeof globalThis.fetch;
    const sleeps: number[] = [];
    const s = new GithubGraphqlSource({ token: 't', fetch, url: 'https://example.invalid/graphql', sleep: async (ms) => void sleeps.push(ms) });
    assert.deepEqual(await s.listShallow('is:issue'), []);
    assert.equal(n, 2);
    assert.deepEqual(sleeps, [1_000]);
  });
});
