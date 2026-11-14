import { OWNER_TOKEN, ownerFetch as fetch } from '../owner-http.ts';
/*
 * #506 GET /api/work/issue, the issue detail of the work board, through the HTTP route: the core's real
 * server, the use case, the ADR-0001 cache and the GraphQL adapter; GitHub is a fake `fetch`.
 * Each scenario names the acceptance criterion it covers.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Accounts, MontadorDoPainel, startLocalApi, type LocalApi } from '../../src/api/index.ts';
import { WORK_ISSUE_ROUTE } from '../../src/api/work-issue.ts';
import { GithubCache, MemoryCacheStore } from '../../src/github/cache.ts';
import { GithubGraphqlSource } from '../../src/github/github-source.ts';
import type { ProjectBoard, ProjectCard } from '../../src/github/project.ts';
import { WorkIssueService } from '../../src/github/work-issue-service.ts';
import { clock, REPO } from '../github/helpers.ts';

const raw = (n: number, over: Record<string, unknown> = {}) => ({
  number: n,
  title: `issue ${n}`,
  url: `https://github.com/${REPO}/issues/${n}`,
  state: 'OPEN',
  repository: { nameWithOwner: REPO },
  issueType: { name: 'Plan' },
  ...over,
});

/** #506 the scenario: two comments, parents #467 > #464, five Plan sub-issues (one closed) and a Task, a PR with 3 of 5 checks done. */
const ISSUE = raw(506, {
  updatedAt: '2026-11-10T10:00:00Z',
  body: 'the body',
  labels: { nodes: [{ name: 'backend' }] },
  milestone: { title: 'Work board' },
  comments: {
    totalCount: 2,
    nodes: [
      { author: { login: 'ana' }, createdAt: '2026-11-10T10:00:00Z', body: 'first' },
      { author: { login: 'bia' }, createdAt: '2026-11-11T10:00:00Z', body: 'second' },
    ],
  },
  parent: raw(467, { issueType: { name: 'Epic' }, parent: raw(464, { issueType: { name: 'Initiative' }, parent: null }) }),
  subIssues: { nodes: [raw(520, { state: 'CLOSED' }), raw(521), raw(522), raw(530, { issueType: { name: 'Task' } }), raw(523), raw(524)] },
  closedByPullRequestsReferences: {
    nodes: [
      {
        number: 900,
        title: 'the pr',
        url: `https://github.com/${REPO}/pull/900`,
        state: 'OPEN',
        isDraft: false,
        reviewDecision: 'REVIEW_REQUIRED',
        commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING', contexts: { totalCount: 5, checkRunCountsByState: [{ state: 'SUCCESS', count: 3 }, { state: 'IN_PROGRESS', count: 2 }] } } } }] },
      },
    ],
  },
});

const card = (n: number): ProjectCard => ({
  itemId: `PVTI_${n}`, kind: 'Issue', key: `${REPO}#${n}`, repo: REPO, number: n, title: `issue ${n}`, url: null, state: 'OPEN', updatedAt: '', type: 'Plan', parent: null, statusId: 'opt-progress',
});
const PROJECT_BOARD = {
  owner: 'ahrenatechnology', number: 3, title: 'Ahrena Console', url: 'u', field: 'Status',
  lanes: [{ id: 'opt-progress', name: 'In Progress', color: 'YELLOW', items: [card(506)] }],
  count: 1, fetchedAt: 0, stale: false, staleReason: null, staleCode: null,
} as unknown as ProjectBoard;

interface Boot {
  api: LocalApi;
  github: { calls: number; mode: 'ok' | 'down' | 'rate-limited' | 'not-found'; secret: string };
  now: ReturnType<typeof clock>;
  logs: string[];
  close(): Promise<void>;
}

async function boot({ withService = true }: { withService?: boolean } = {}): Promise<Boot> {
  const storage = openSqliteStorage({ path: ':memory:' });
  const now = clock();
  const github: Boot['github'] = { calls: 0, mode: 'ok', secret: 'raw-github-text-never-on-screen' };
  const fakeFetch = (async () => {
    github.calls++;
    if (github.mode === 'down') throw new TypeError(github.secret);
    if (github.mode === 'rate-limited') return new Response(JSON.stringify({ message: github.secret }), { status: 429, headers: { 'retry-after': '60' } });
    if (github.mode === 'not-found') return new Response(JSON.stringify({ data: { repository: { issue: null } } }), { status: 200 });
    return new Response(JSON.stringify({ data: { repository: { issue: ISSUE } } }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  const logs: string[] = [];
  const service = new WorkIssueService({
    source: new GithubGraphqlSource({ token: 'test-token', fetch: fakeFetch, sleep: async () => {} }),
    cache: new GithubCache({ store: new MemoryCacheStore(), now }),
    project: { board: async () => PROJECT_BOARD },
    log: (m) => logs.push(m),
  });
  const panelBuilder = new MontadorDoPainel({ storage, contas: new Accounts({ storage, file: null }), desktop: null, trabalho: null });
  const api = await startLocalApi({
    ownerToken: () => OWNER_TOKEN,
    panelBuilder,
    hooks: { storage },
    port: 0,
    log: () => {},
    ...(withService ? { workIssue: { service } } : {}),
  });
  return { api, github, now, logs, async close() { await api.close(); await storage.close(); } };
}

const QUERY = `?repo=${REPO}&number=506`;

async function get(b: Boot, query = QUERY, headers: Record<string, string> = {}) {
  const r = await fetch(`${b.api.url}${WORK_ISSUE_ROUTE}${query}`, { headers });
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

describe('#506/AC-1 GET /api/work/issue: the issue with its body, comments, parents, sub-issues and pull request', () => {
  test('#506/AC-1 Given #506 with two comments, parents #467 > #464 and a PR with CI pending, When the detail is read, Then 200 with the header, body, comments, parents root-first and the pull request', () =>
    withApi(async (b) => {
      const { status, json } = await get(b);
      assert.equal(status, 200);
      assert.deepEqual(
        [json.type, json.number, json.title, json.state, json.url, json.repo, json.labels, json.milestone, json.projectStatus],
        ['Plan', 506, 'issue 506', 'OPEN', `https://github.com/${REPO}/issues/506`, REPO, ['backend'], 'Work board', 'In Progress'],
      );
      assert.equal(json.body, 'the body');
      assert.equal(json.updatedAt, '2026-11-10T10:00:00Z', '#533/AC-1 the read carries GitHub updatedAt, for the conflict check');
      assert.deepEqual(json.comments, [
        { author: 'ana', createdAt: '2026-11-10T10:00:00Z', body: 'first' },
        { author: 'bia', createdAt: '2026-11-11T10:00:00Z', body: 'second' },
      ]);
      assert.deepEqual(json.parents.map((p: any) => p.number), [464, 467]);
      assert.deepEqual(json.subIssues.map((s: any) => [s.number, s.state]), [[520, 'CLOSED'], [521, 'OPEN'], [522, 'OPEN'], [530, 'OPEN'], [523, 'OPEN'], [524, 'OPEN']]);
      assert.deepEqual(json.pullRequest, {
        number: 900,
        title: 'the pr',
        url: `https://github.com/${REPO}/pull/900`,
        state: 'OPEN',
        isDraft: false,
        ci: 'PENDING',
        checks: { total: 5, passed: 3, failed: 0, running: 2 },
        review: 'REVIEW_REQUIRED',
      });
      assert.deepEqual([json.stale, json.staleReason, typeof json.fetchedAt], [false, null, 'number']);
    }));

  test('#506/AC-1 the second read inside the TTL does not call GitHub again; refresh=1 after the 30 s floor does', () =>
    withApi(async (b) => {
      await get(b);
      await get(b);
      assert.equal(b.github.calls, 1);
      b.now.add(31_000);
      await get(b, `${QUERY}&refresh=1`);
      assert.equal(b.github.calls, 2);
    }));
});

describe('#506/AC-2 GET /api/work/issue: the plan steps', () => {
  test('#506/AC-2 Given five Plan sub-issues and one Task, Then plan has count 5 and the Plan steps in order', () =>
    withApi(async (b) => {
      const { json } = await get(b);
      assert.equal(json.plan.count, 5);
      assert.deepEqual(json.plan.steps.map((s: any) => [s.number, s.title, s.state]), [
        [520, 'issue 520', 'CLOSED'],
        [521, 'issue 521', 'OPEN'],
        [522, 'issue 522', 'OPEN'],
        [523, 'issue 523', 'OPEN'],
        [524, 'issue 524', 'OPEN'],
      ]);
    }));
});

describe('#506/AC-3 GET /api/work/issue: GitHub off or down, an unknown issue', () => {
  test('#506/AC-3 Given --no-github (no service), Then 503 off', () =>
    withApi(async (b) => {
      assert.deepEqual(await get(b), { status: 503, json: { error: 'off' } });
    }, { withService: false }));

  test('#506/AC-3 Given GitHub down and nothing stored, Then 502 github-unavailable with the stable code and never the raw text', () =>
    withApi(async (b) => {
      b.github.mode = 'down';
      const r = await get(b);
      assert.deepEqual([r.status, r.json], [502, { error: 'github-unavailable', reason: 'network' }]);
      assert.ok(!JSON.stringify(r.json).includes(b.github.secret));
      b.github.mode = 'rate-limited';
      assert.equal((await get(b)).json.reason, 'rate-limited');
    }));

  test('#506/AC-3 Given GitHub down after a good read, Then 200 with the last value, stale, the code and fetchedAt', () =>
    withApi(async (b) => {
      const first = await get(b);
      b.github.mode = 'down';
      b.now.add(61_000);
      const r = await get(b);
      assert.equal(r.status, 200);
      assert.deepEqual([r.json.stale, r.json.staleReason, r.json.fetchedAt, r.json.title], [true, 'network', first.json.fetchedAt, 'issue 506']);
      assert.ok(!JSON.stringify(r.json).includes(b.github.secret));
      assert.ok(b.logs.some((l) => l.includes(b.github.secret)), 'the raw text goes to the core log');
    }));

  test('#506/AC-3 Given an issue GitHub does not know, Then 404 not-found', () =>
    withApi(async (b) => {
      b.github.mode = 'not-found';
      assert.deepEqual(await get(b, `?repo=${REPO}&number=99999`), { status: 404, json: { error: 'not-found' } });
    }));

  test('#506/AC-3 a missing or invalid repo or number is 400 bad-param with the param', () =>
    withApi(async (b) => {
      for (const [query, param] of [
        ['?number=506', 'repo'],
        [`?repo=nope&number=506`, 'repo'],
        [`?repo=${REPO}`, 'number'],
        [`?repo=${REPO}&number=abc`, 'number'],
        [`?repo=${REPO}&number=0`, 'number'],
        [`?repo=${REPO}&number=5.5`, 'number'],
        // #506 GitHub's GraphQL Int is 32-bit: above it the read would fail as a 502, so it is the caller's 400
        [`?repo=${REPO}&number=2147483648`, 'number'],
        [`?repo=${REPO}&number=9999999999`, 'number'],
      ] as const) {
        assert.deepEqual(await get(b, query), { status: 400, json: { error: 'bad-param', param } }, query);
      }
      assert.equal(b.github.calls, 0);
    }));

  test('#506/AC-3 only GET: another method is 405', () =>
    withApi(async (b) => {
      const r = await fetch(`${b.api.url}${WORK_ISSUE_ROUTE}${QUERY}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.deepEqual([r.status, await r.json()], [405, { error: 'method-not-allowed' }]);
      assert.equal(b.github.calls, 0);
    }));

  test("#506/AC-3 another site's page never reads the issue (it spends GitHub quota): 403", () =>
    withApi(async (b) => {
      assert.equal((await get(b, QUERY, { 'sec-fetch-site': 'cross-site' })).status, 403);
      assert.equal(b.github.calls, 0);
    }));
});
