// As leituras do GitHub do Dev Console (#177/AC-5): o adaptador GraphQL sobre respostas sintéticas
// (um `fetch` falso, sem rede) e o cache da 0001 por cima, com TTL e o fallback sem GitHub.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { GithubCache, MemoryCacheStore } from '../../src/github/cache.ts';
import { DEV_CONSOLE_TTL, devConsoleCacheKey, DevConsoleGithub } from '../../src/dev-console/reader.ts';
import { DEV_CONSOLE_QUERIES, disabledDevConsoleSource, GithubDevConsoleSource, searchDate, type DevConsoleSource } from '../../src/dev-console/source.ts';
import { clock } from '../github/helpers.ts';
import { issue, pr, REPO } from './helpers.ts';

type Call = { operation: string; variables: Record<string, unknown>; auth: string };

function fakeFetch(bodies: Record<string, unknown>) {
  const calls: Call[] = [];
  const f = (async (_url: string, init?: RequestInit) => {
    const { query, variables } = JSON.parse(String(init?.body));
    const operation = /query (\w+)/.exec(query)?.[1] ?? '?';
    calls.push({ operation, variables, auth: (init?.headers as Record<string, string>).authorization });
    return new Response(JSON.stringify({ data: { rateLimit: { cost: 1, remaining: 4999 }, ...(bodies[operation] as object) } }), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe('adaptador GraphQL', () => {
  test('#177/AC-5 PRs abertos com rascunho, mergeable, base, CI e review, e os mesclados desde a janela', async () => {
    const { f, calls } = fakeFetch({
      DevConsolePullRequests: {
        repository: {
          pullRequests: {
            nodes: [
              {
                number: 81, title: 'Exportação', url: 'u81', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', baseRefName: 'main',
                headRefName: 'feat/31-csv', isCrossRepository: false, createdAt: '2026-11-01T10:00:00Z', reviewDecision: 'APPROVED',
                commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
                closingIssuesReferences: { nodes: [{ number: 31, repository: { nameWithOwner: REPO } }, { number: 9, repository: { nameWithOwner: 'dev-sintetico/outro' } }] },
              },
              { number: 84, title: 'Empilhado', url: 'u84', isDraft: true, mergeable: 'UNKNOWN', mergeStateStatus: null, baseRefName: 'feat/31-csv', headRefName: 'feat/60-x', isCrossRepository: true, createdAt: '2026-11-01T11:00:00Z', reviewDecision: null, commits: { nodes: [{ commit: { statusCheckRollup: null } }] } },
            ],
          },
        },
        merged: { nodes: [{ number: 80, title: 'Paginação', url: 'u80', mergedAt: '2026-11-02T09:00:00Z' }, {}] },
      },
    });
    const source = new GithubDevConsoleSource({ token: 'token-sintetico', fetch: f });
    const r = await source.pullRequests(REPO, '2026-11-01T12:00:00.123Z');
    assert.deepEqual(calls[0].variables, { o: 'dev-sintetico', r: 'catalogo-exemplo', merged: `repo:${REPO} is:pr is:merged merged:>=2026-11-01T12:00:00Z` });
    assert.equal(calls[0].auth, 'bearer token-sintetico');
    assert.deepEqual(r.open[0], {
      repo: REPO, number: 81, title: 'Exportação', url: 'u81', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', baseRefName: 'main',
      headRefName: 'feat/31-csv', isCrossRepository: false, createdAt: '2026-11-01T10:00:00Z', ci: 'SUCCESS', review: 'APPROVED', closes: [31],
    });
    assert.deepEqual([r.open[1].ci, r.open[1].closes, r.open[1].isDraft, r.open[1].isCrossRepository], [null, [], true, true]);
    assert.equal(r.truncated, false);
    assert.deepEqual(r.merged, [{ repo: REPO, number: 80, title: 'Paginação', url: 'u80', mergedAt: '2026-11-02T09:00:00Z' }]);
  });

  test('#177/AC-5 issues abertas com etiquetas, as fechadas como concluídas desde a janela, e os branches do remoto', async () => {
    const { f, calls } = fakeFetch({
      DevConsoleIssues: {
        repository: { issues: { nodes: [{ number: 55, title: 'PIX', url: 'u55', state: 'OPEN', labels: { nodes: [{ name: 'blocked' }] } }] } },
        closed: { nodes: [{ number: 52, title: 'Paginação', url: 'u52', state: 'CLOSED', closedAt: '2026-11-02T09:00:00Z', labels: { nodes: [] } }, {}] },
      },
      DevConsoleBranches: { repository: { refs: { nodes: [{ name: 'main' }, { name: 'feat/61-cobranca' }] } } },
    });
    const source = new GithubDevConsoleSource({ token: 'token-sintetico', fetch: f });
    const issues = await source.issues(REPO, '2026-11-01T12:00:00Z');
    assert.equal(calls[0].variables.closed, `repo:${REPO} is:issue is:closed reason:completed closed:>=2026-11-01T12:00:00Z`);
    assert.deepEqual(issues.open, [{ repo: REPO, number: 55, title: 'PIX', url: 'u55', state: 'OPEN', labels: ['blocked'], closedAt: null }]);
    assert.deepEqual(issues.closed.map((i) => [i.number, i.closedAt]), [[52, '2026-11-02T09:00:00Z']]);
    assert.deepEqual(await source.branches(REPO), { names: ['main', 'feat/61-cobranca'], truncated: false });
  });

  test('#177/AC-5 com mais do que a página, a leitura vem truncated', async () => {
    const page = { pageInfo: { hasNextPage: true }, nodes: [] };
    const empty = { pageInfo: { hasNextPage: false }, nodes: [] };
    const { f } = fakeFetch({
      DevConsolePullRequests: { repository: { pullRequests: empty }, merged: page },
      DevConsoleIssues: { repository: { issues: page }, closed: empty },
      DevConsoleBranches: { repository: { refs: page } },
    });
    const source = new GithubDevConsoleSource({ token: 'token-sintetico', fetch: f });
    assert.equal((await source.pullRequests(REPO, '2026-11-01T12:00:00Z')).truncated, true);
    assert.equal((await source.issues(REPO, '2026-11-01T12:00:00Z')).truncated, true);
    assert.equal((await source.branches(REPO)).truncated, true);
    assert.ok(DEV_CONSOLE_QUERIES.pullRequests.includes('isCrossRepository'));
    for (const q of Object.values(DEV_CONSOLE_QUERIES)) assert.match(q, /pageInfo \{ hasNextPage \}/);
  });

  test('#177/AC-5 um 401 esquece o token guardado, e a próxima leitura pede de novo ao gh', async () => {
    let asked = 0;
    let status = 401;
    const f = (async () =>
      status === 401
        ? new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 })
        : new Response(JSON.stringify({ data: { repository: { refs: { nodes: [{ name: 'main' }] } } } }), { status: 200 })) as unknown as typeof fetch;
    const source = new GithubDevConsoleSource({ token: async () => `token-sintetico-${++asked}`, fetch: f });
    await assert.rejects(source.branches(REPO), /401/);
    status = 200;
    assert.deepEqual((await source.branches(REPO)).names, ['main']);
    await source.branches(REPO);
    assert.equal(asked, 2, 'pediu o token de novo só depois do 401');
  });

  test('searchDate tira os milissegundos', () => {
    assert.equal(searchDate('2026-11-01T12:00:00.999Z'), '2026-11-01T12:00:00Z');
  });
});

function countingSource(): DevConsoleSource & { calls: string[]; offline: boolean } {
  const s = {
    calls: [] as string[],
    offline: false,
    async pullRequests(repo: string) {
      s.calls.push(`pullRequests:${repo}`);
      if (s.offline) throw new Error('rede caiu');
      return { open: [pr(81)], merged: [] };
    },
    async issues(repo: string) {
      s.calls.push(`issues:${repo}`);
      if (s.offline) throw new Error('rede caiu');
      return { open: [issue(31)], closed: [] };
    },
    async branches(repo: string) {
      s.calls.push(`branches:${repo}`);
      if (s.offline) throw new Error('rede caiu');
      return { names: ['main'] };
    },
  };
  return s;
}

describe('pelo cache da 0001', () => {
  test('#177/AC-5 dentro do TTL não chama o GitHub; PRs e branches com o TTL dos PRs, issues com o das issues', async () => {
    const now = clock();
    const store = new MemoryCacheStore();
    const source = countingSource();
    const github = new DevConsoleGithub({ source, cache: new GithubCache({ store, now }), now });
    const first = await github.read(REPO);
    await github.read(REPO);
    assert.equal(source.calls.length, 3);
    assert.deepEqual([first.branches, first.truncated], [['main'], false]);
    assert.deepEqual([...store.entries.keys()].sort(), [devConsoleCacheKey('branches', REPO), devConsoleCacheKey('issues', REPO), devConsoleCacheKey('pullRequests', REPO)]);
    assert.equal(store.entries.get(devConsoleCacheKey('pullRequests', REPO))?.etag, null);
    now.add(DEV_CONSOLE_TTL.pullRequests);
    await github.read(REPO);
    assert.deepEqual(source.calls.slice(3).sort(), [`branches:${REPO}`, `pullRequests:${REPO}`]);
    now.add(DEV_CONSOLE_TTL.issues);
    await github.read(REPO);
    assert.ok(source.calls.slice(5).includes(`issues:${REPO}`));
  });

  test('#177/AC-5 sem GitHub, devolve o cache com readAt e stale: true', async () => {
    const now = clock();
    const source = countingSource();
    const github = new DevConsoleGithub({ source, cache: new GithubCache({ store: new MemoryCacheStore(), now }), now });
    const first = await github.read(REPO);
    assert.equal(first.stale, false);
    const readAt = first.readAt;
    now.add(DEV_CONSOLE_TTL.issues + 1);
    source.offline = true;
    const r = await github.read(REPO);
    assert.equal(r.stale, true);
    assert.match(r.staleReason ?? '', /rede caiu/);
    assert.equal(r.readAt, readAt);
    assert.deepEqual(r.openPullRequests.map((p) => p.number), [81]);
    assert.deepEqual(r.openIssues.map((i) => i.number), [31]);
  });

  test('#177/AC-5 sem GitHub e sem cache: vazio, stale e sem readAt', async () => {
    const github = new DevConsoleGithub({ source: disabledDevConsoleSource(), cache: new GithubCache({ store: new MemoryCacheStore() }) });
    const r = await github.read(REPO);
    assert.deepEqual([r.openPullRequests, r.openIssues, r.branches, r.readAt, r.stale, r.truncated], [[], [], [], null, true, false]);
    assert.match(r.staleReason ?? '', /--sem-github/);
  });
});
