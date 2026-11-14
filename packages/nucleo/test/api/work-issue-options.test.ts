import { OWNER_TOKEN, ownerFetch as fetch } from '../owner-http.ts';
/*
 * #590 GET /api/work/issue/options, the issue options of a repository (labels, issue types, open
 * milestones, parent candidates), through the HTTP route: the core's real server, the use case, the
 * ADR-0001 cache and the GraphQL adapter; GitHub is a fake `fetch`.
 * Each scenario names the acceptance criterion it covers.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Accounts, MontadorDoPainel, startLocalApi, type LocalApi } from '../../src/api/index.ts';
import { WORK_ISSUE_OPTIONS_ROUTE } from '../../src/api/work-issue-options.ts';
import { GithubCache, MemoryCacheStore } from '../../src/github/cache.ts';
import { GithubGraphqlSource } from '../../src/github/github-source.ts';
import { WorkIssueOptionsService } from '../../src/github/work-issue-options.ts';
import { clock, REPO } from '../github/helpers.ts';

/** The repository as GitHub answers the options query: closed milestones are filtered by the query itself (states: OPEN). */
const REPOSITORY = {
  labels: { nodes: [{ name: 'backend' }, { name: 'bug' }] },
  issueTypes: { nodes: [{ name: 'Epic' }, { name: 'Plan' }, { name: 'Task' }] },
  milestones: { nodes: [{ title: 'Work board' }, { title: 'Sprint 2' }] },
  issues: {
    nodes: [
      { number: 574, title: 'Edit mode', repository: { nameWithOwner: REPO } },
      { number: 467, title: 'Work board', repository: { nameWithOwner: REPO } },
    ],
  },
};

interface Boot {
  api: LocalApi;
  github: { calls: number; mode: 'ok' | 'down' | 'rate-limited' | 'unknown-repo'; secret: string; queries: string[] };
  now: ReturnType<typeof clock>;
  logs: string[];
  close(): Promise<void>;
}

async function boot({ withService = true }: { withService?: boolean } = {}): Promise<Boot> {
  const storage = openSqliteStorage({ path: ':memory:' });
  const now = clock();
  const github: Boot['github'] = { calls: 0, mode: 'ok', secret: 'raw-github-text-never-on-screen', queries: [] };
  const fakeFetch = (async (_url: unknown, init?: { body?: string }) => {
    github.calls++;
    github.queries.push(String(init?.body ?? ''));
    if (github.mode === 'down') throw new TypeError(github.secret);
    if (github.mode === 'rate-limited') return new Response(JSON.stringify({ message: github.secret }), { status: 429, headers: { 'retry-after': '60' } });
    if (github.mode === 'unknown-repo') return new Response(JSON.stringify({ data: { repository: null } }), { status: 200 });
    return new Response(JSON.stringify({ data: { repository: REPOSITORY } }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  const logs: string[] = [];
  const service = new WorkIssueOptionsService({
    source: new GithubGraphqlSource({ token: 'test-token', fetch: fakeFetch, sleep: async () => {} }),
    cache: new GithubCache({ store: new MemoryCacheStore(), now }),
    log: (m) => logs.push(m),
  });
  const panelBuilder = new MontadorDoPainel({ storage, contas: new Accounts({ storage, file: null }), desktop: null, trabalho: null });
  const api = await startLocalApi({
    ownerToken: () => OWNER_TOKEN,
    panelBuilder,
    hooks: { storage },
    port: 0,
    log: () => {},
    ...(withService ? { workIssueOptions: { service } } : {}),
  });
  return { api, github, now, logs, async close() { await api.close(); await storage.close(); } };
}

const QUERY = `?repo=${REPO}`;

async function get(b: Boot, query = QUERY, headers: Record<string, string> = {}) {
  const r = await fetch(`${b.api.url}${WORK_ISSUE_OPTIONS_ROUTE}${query}`, { headers });
  return { status: r.status, json: (await r.json()) as any };
}

async function withApi(fn: (b: Boot) => Promise<void>, options?: Parameters<typeof boot>[0]) {
  const b = await boot(options);
  try {
    await fn(b);
  } finally {
    await b.close();
  }
}

describe('#590/AC-1 GET /api/work/issue/options: the repository labels, types, open milestones and parent candidates', () => {
  test('#590/AC-1 Given a repository with labels, types, milestones and open issues, When the options are read, Then 200 with each list, the parents as owner/name#N keys with title, fresh', () =>
    withApi(async (b) => {
      const { status, json } = await get(b);
      assert.equal(status, 200);
      assert.deepEqual(json.labels, ['backend', 'bug']);
      assert.deepEqual(json.types, ['Epic', 'Plan', 'Task']);
      assert.deepEqual(json.milestones, ['Work board', 'Sprint 2']);
      assert.deepEqual(json.parents, [
        { key: `${REPO}#574`, title: 'Edit mode' },
        { key: `${REPO}#467`, title: 'Work board' },
      ]);
      assert.deepEqual([json.stale, json.staleReason, typeof json.fetchedAt], [false, null, 'number']);
      assert.equal(b.github.calls, 1, 'one GraphQL query');
      assert.ok(b.github.queries[0]!.includes('states: [OPEN]') || b.github.queries[0]!.includes('states:[OPEN]'), 'only the open milestones are asked');
    }));

  test('#590/AC-1 the second read inside the TTL does not call GitHub again, in any letter case of the repo; refresh=1 after the 30 s floor does', () =>
    withApi(async (b) => {
      await get(b);
      await get(b, `?repo=${REPO.toUpperCase()}`);
      assert.equal(b.github.calls, 1);
      b.now.add(31_000);
      await get(b, `${QUERY}&refresh=1`);
      assert.equal(b.github.calls, 2);
    }));

  test('#590/AC-1 a repository GitHub does not know is 404 not-found', () =>
    withApi(async (b) => {
      b.github.mode = 'unknown-repo';
      assert.deepEqual(await get(b), { status: 404, json: { error: 'not-found' } });
    }));
});

describe('#590/AC-2 GET /api/work/issue/options: a malformed repo, --no-github, another site, another method', () => {
  test('#590/AC-2 a missing or malformed repo is 400 bad-param repo and never calls GitHub', () =>
    withApi(async (b) => {
      for (const query of ['', '?repo=', '?repo=nope', '?repo=a/b/c', '?repo=a%20b/c']) {
        assert.deepEqual(await get(b, query), { status: 400, json: { error: 'bad-param', param: 'repo' } }, query);
      }
      assert.equal(b.github.calls, 0);
    }));

  test('#590/AC-2 Given --no-github (no service), Then 503 off', () =>
    withApi(async (b) => {
      assert.deepEqual(await get(b), { status: 503, json: { error: 'off' } });
    }, { withService: false }));

  test("#590/AC-2 another site's page never reads the options (it spends GitHub quota): 403", () =>
    withApi(async (b) => {
      assert.equal((await get(b, QUERY, { 'sec-fetch-site': 'cross-site' })).status, 403);
      assert.equal(b.github.calls, 0);
    }));

  test('#590/AC-2 only GET: another method is 405', () =>
    withApi(async (b) => {
      const r = await fetch(`${b.api.url}${WORK_ISSUE_OPTIONS_ROUTE}${QUERY}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.deepEqual([r.status, await r.json()], [405, { error: 'method-not-allowed' }]);
      assert.equal(b.github.calls, 0);
    }));
});

describe('#590/AC-3 GET /api/work/issue/options: GitHub down', () => {
  test('#590/AC-3 Given GitHub down and nothing stored, Then 502 github-unavailable with the stable code and never the raw text', () =>
    withApi(async (b) => {
      b.github.mode = 'down';
      const r = await get(b);
      assert.deepEqual([r.status, r.json], [502, { error: 'github-unavailable', reason: 'network' }]);
      assert.ok(!JSON.stringify(r.json).includes(b.github.secret));
      b.github.mode = 'rate-limited';
      assert.equal((await get(b)).json.reason, 'rate-limited');
    }));

  test('#590/AC-3 Given GitHub down after a good read, Then 200 with the last value, stale, the code and fetchedAt', () =>
    withApi(async (b) => {
      const first = await get(b);
      b.github.mode = 'down';
      b.now.add(10 * 60_000);
      const r = await get(b);
      assert.equal(r.status, 200);
      assert.deepEqual([r.json.stale, r.json.staleReason, r.json.fetchedAt, r.json.labels], [true, 'network', first.json.fetchedAt, ['backend', 'bug']]);
      assert.ok(!JSON.stringify(r.json).includes(b.github.secret));
      assert.ok(b.logs.some((l) => l.includes(b.github.secret)), 'the raw text goes to the core log');
    }));
});
