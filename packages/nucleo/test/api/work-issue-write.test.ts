import { OWNER_TOKEN, ownerFetch as fetch } from '../owner-http.ts';
/*
 * #533 PATCH /api/work/issue and POST /api/work/issue/comments, through the HTTP route: the core's real
 * server, the use case, the ADR-0001 cache and the GraphQL adapter; GitHub is a fake `fetch` that holds
 * one issue and records what is written. Each scenario names the acceptance criterion it covers.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Accounts, MontadorDoPainel, startLocalApi, type LocalApi } from '../../src/api/index.ts';
import { WORK_ISSUE_COMMENTS_ROUTE, WORK_ISSUE_ROUTE } from '../../src/api/work-issue.ts';
import { GithubCache, MemoryCacheStore } from '../../src/github/cache.ts';
import { GithubGraphqlSource } from '../../src/github/github-source.ts';
import { WorkIssueService } from '../../src/github/work-issue-service.ts';
import { clock, REPO } from '../github/helpers.ts';

const OPENED_AT = '2026-11-10T10:00:00Z';

interface Github {
  calls: number;
  writes: string[];
  mode: 'ok' | 'down' | 'forbidden' | 'unread';
  title: string;
  body: string;
  labels: string[];
  comments: string[];
  updatedAt: string;
  secret: string;
}

const detail = (g: Github) => ({
  number: 533, title: g.title, url: `https://github.com/${REPO}/issues/533`, state: 'OPEN', updatedAt: g.updatedAt,
  repository: { nameWithOwner: REPO }, issueType: { name: 'Plan' }, body: g.body, labels: { nodes: g.labels.map((name) => ({ name })) }, milestone: null,
  comments: { totalCount: g.comments.length, nodes: g.comments.map((body) => ({ author: { login: 'me' }, createdAt: '2026-11-12T13:00:00Z', body })) },
  parent: null, subIssues: { nodes: [] }, closedByPullRequestsReferences: { nodes: [] },
});

interface Boot { api: LocalApi; github: Github; logs: string[]; host: string; close(): Promise<void> }

async function boot({ withService = true }: { withService?: boolean } = {}): Promise<Boot> {
  const storage = openSqliteStorage({ path: ':memory:' });
  const github: Github = { calls: 0, writes: [], mode: 'ok', title: 'issue 533', body: 'the body', labels: ['backend'], comments: [], updatedAt: OPENED_AT, secret: 'raw-github-text-never-on-screen' };
  const fakeFetch = (async (_u: string, init: RequestInit) => {
    github.calls++;
    if (github.mode === 'down') throw new TypeError(github.secret);
    const { query, variables } = JSON.parse(String(init.body));
    const op = /(?:query|mutation) (\w+)/.exec(query)![1];
    // #533 'unread': the writes are applied and the read of the issue afterwards fails.
    if (github.mode === 'unread' && op === 'WorkIssue') throw new TypeError(github.secret);
    const isWrite = /^(Update|Add|Remove)/.test(op);
    if (isWrite && github.mode === 'forbidden') return new Response(JSON.stringify({ message: github.secret }), { status: 403 });
    let data: Record<string, unknown> = {};
    if (op === 'WorkIssue') data = { repository: { issue: detail(github) } };
    else if (op === 'WorkIssueCurrent') data = { repository: { issue: { title: github.title, body: github.body, updatedAt: github.updatedAt } } };
    else if (op === 'WorkIssueId') data = { repository: { issue: { id: `I_${variables.n}` } } };
    else if (op === 'WorkIssueTargets') {
      const repository: Record<string, unknown> = { id: 'R_1', issue: { id: 'I_533', viewerCanUpdate: true, parent: null }, issueTypes: { nodes: [] }, milestones: { nodes: [] } };
      const known: Record<string, string> = { backend: 'L_back', frontend: 'L_front' };
      for (const [name, value] of Object.entries<string>(variables)) if (/^l\d+$/.test(name)) repository[name] = known[value] ? { id: known[value], name: value } : null;
      data = { repository };
    } else if (op === 'UpdateWorkIssue') {
      const i = variables.input;
      github.writes.push(op);
      if (i.title !== undefined) github.title = i.title;
      if (i.body !== undefined) github.body = i.body;
      if (i.labelIds) github.labels = i.labelIds.map((id: string) => (id === 'L_back' ? 'backend' : 'frontend'));
      github.updatedAt = '2026-11-12T12:00:00Z';
    } else if (op === 'AddWorkIssueComment') {
      github.writes.push(op);
      github.comments.push(variables.input.body);
      github.updatedAt = '2026-11-12T13:00:00Z';
    }
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  const logs: string[] = [];
  const service = new WorkIssueService({
    source: new GithubGraphqlSource({ token: 'test-token', fetch: fakeFetch, sleep: async () => {} }),
    writer: new GithubGraphqlSource({ token: 'test-token', fetch: fakeFetch, sleep: async () => {} }),
    cache: new GithubCache({ store: new MemoryCacheStore(), now: clock() }),
    log: (m) => logs.push(m),
  });
  const panelBuilder = new MontadorDoPainel({ storage, contas: new Accounts({ storage, file: null }), desktop: null, trabalho: null });
  const api = await startLocalApi({ ownerToken: () => OWNER_TOKEN, panelBuilder, hooks: { storage }, port: 0, log: () => {}, ...(withService ? { workIssue: { service } } : {}) });
  return { api, github, logs, host: new URL(api.url).host, async close() { await api.close(); await storage.close(); } };
}

async function withApi(fn: (b: Boot) => Promise<void>, options?: Parameters<typeof boot>[0]) {
  const b = await boot(options);
  try {
    await fn(b);
  } finally {
    await b.close();
  }
}

const send = (b: Boot, method: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${b.api.url}${path}`, { method, headers: { 'content-type': 'application/json', origin: `http://${b.host}`, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const patch = async (b: Boot, body: Record<string, unknown>) => {
  const r = await send(b, 'PATCH', WORK_ISSUE_ROUTE, { repo: REPO, number: 533, ...body });
  return { status: r.status, json: (await r.json()) as any };
};
const comment = async (b: Boot, body: Record<string, unknown>) => {
  const r = await send(b, 'POST', WORK_ISSUE_COMMENTS_ROUTE, { repo: REPO, number: 533, ...body });
  return { status: r.status, json: (await r.json()) as any };
};
const getIssue = async (b: Boot) => (await (await fetch(`${b.api.url}${WORK_ISSUE_ROUTE}?repo=${REPO}&number=533`)).json()) as any;

describe('#533/AC-1 the routes write to GitHub and the cache holds what GitHub returned', () => {
  test('#533/AC-1 Given a title and body save opened at the current updatedAt, Then GitHub holds them, 200 carries the issue as GitHub returned it, and a GET is served from the cache', async () =>
    withApi(async (b) => {
      const r = await patch(b, { title: 'new title', body: 'new body', updatedAt: OPENED_AT });
      assert.equal(r.status, 200);
      assert.deepEqual([r.json.title, r.json.body, r.json.updatedAt, r.json.number, r.json.stale], ['new title', 'new body', '2026-11-12T12:00:00Z', 533, false]);
      assert.deepEqual([b.github.title, b.github.body], ['new title', 'new body']);
      const calls = b.github.calls;
      const again = await getIssue(b);
      assert.deepEqual([again.title, again.updatedAt, b.github.calls], ['new title', '2026-11-12T12:00:00Z', calls]);
    }));

  test('#533/AC-1 Given labels, Then GitHub holds them with no updatedAt needed', async () =>
    withApi(async (b) => {
      const r = await patch(b, { labels: ['frontend'] });
      assert.deepEqual([r.status, r.json.labels, b.github.labels], [200, ['frontend'], ['frontend']]);
    }));

  test('#533/AC-1 Given a comment, Then it is on GitHub and the answer and the cache carry the issue with it', async () =>
    withApi(async (b) => {
      const r = await comment(b, { body: 'hello' });
      assert.deepEqual([r.status, r.json.commentsTotal, r.json.comments[0].body, b.github.comments], [200, 1, 'hello', ['hello']]);
      const calls = b.github.calls;
      assert.equal((await getIssue(b)).comments[0].body, 'hello');
      assert.equal(b.github.calls, calls);
    }));
});

describe('#533/AC-2 a title or body save older than GitHub is a 409', () => {
  test("#533/AC-2 Given GitHub was edited after the panel opened, Then nothing is written and 409 carries GitHub's title, body and updatedAt", async () =>
    withApi(async (b) => {
      b.github.title = 'edited on github';
      b.github.updatedAt = '2026-11-11T09:00:00Z';
      const r = await patch(b, { title: 'mine', updatedAt: OPENED_AT });
      assert.deepEqual([r.status, r.json], [409, { error: 'conflict', title: 'edited on github', body: 'the body', updatedAt: '2026-11-11T09:00:00Z' }]);
      assert.deepEqual(b.github.writes, []);
    }));

  test('#533/AC-2 a title or body save with no valid updatedAt is 400 bad-param updatedAt, and labels need none', async () =>
    withApi(async (b) => {
      assert.deepEqual(await patch(b, { title: 'x' }), { status: 400, json: { error: 'bad-param', param: 'updatedAt' } });
      assert.deepEqual(await patch(b, { body: 'x', updatedAt: 'yesterday' }), { status: 400, json: { error: 'bad-param', param: 'updatedAt' } });
      assert.equal(b.github.calls, 0);
      assert.equal((await patch(b, { labels: [] })).status, 200);
    }));
});

describe('#533/AC-3 a GitHub refusal answers with a stable reason and leaves the cache as it was', () => {
  test('#533/AC-3 Given GitHub refuses the write (403), Then 502 github-refused with reason no-permission, the raw text only in the log, and the cache still serves the old issue', async () =>
    withApi(async (b) => {
      await getIssue(b);
      b.github.mode = 'forbidden';
      const r = await patch(b, { labels: ['frontend'] });
      assert.deepEqual([r.status, r.json], [502, { error: 'github-refused', reason: 'no-permission' }]);
      assert.ok(!JSON.stringify(r.json).includes(b.github.secret));
      assert.ok(b.logs.some((l) => l.includes(b.github.secret)));
      const c = await comment(b, { body: 'x' });
      assert.deepEqual([c.status, c.json.reason], [502, 'no-permission']);
      b.github.mode = 'ok';
      const calls = b.github.calls;
      assert.deepEqual([(await getIssue(b)).labels, b.github.calls], [['backend'], calls]);
    }));

  test('#533/AC-3 Given GitHub is unreachable, Then 502 github-unavailable with reason network', async () =>
    withApi(async (b) => {
      b.github.mode = 'down';
      const r = await patch(b, { labels: [] });
      assert.deepEqual([r.status, r.json], [502, { error: 'github-unavailable', reason: 'network' }]);
      assert.ok(!JSON.stringify(r.json).includes(b.github.secret));
    }));

  test('#533/AC-3 Given GitHub was written and the read-back fails, Then 502 written-unread with the reason, the raw text only in the log, and the next GET re-reads GitHub (the new version, not the cached one)', async () =>
    withApi(async (b) => {
      await getIssue(b);
      b.github.mode = 'unread';
      const r = await patch(b, { labels: ['frontend'] });
      assert.deepEqual([r.status, r.json], [502, { error: 'written-unread', reason: 'network' }]);
      assert.ok(!JSON.stringify(r.json).includes(b.github.secret));
      assert.ok(b.logs.some((l) => l.includes(b.github.secret)));
      const c = await comment(b, { body: 'once' });
      assert.deepEqual([c.status, c.json.error], [502, 'written-unread']);
      assert.deepEqual(b.github.comments, ['once']);
      b.github.mode = 'ok';
      const again = await getIssue(b);
      assert.deepEqual([again.labels, again.comments[0].body], [['frontend'], 'once']);
    }));

  test('#533/AC-3 a label GitHub does not know is 422 unknown-value with the param, and nothing is written', async () =>
    withApi(async (b) => {
      assert.deepEqual(await patch(b, { labels: ['nope'] }), { status: 422, json: { error: 'unknown-value', param: 'labels' } });
      assert.deepEqual(b.github.writes, []);
    }));

  test('#533/AC-3 --no-github (no service) is 503 off for both routes', async () =>
    withApi(async (b) => {
      assert.deepEqual(await patch(b, { labels: [] }), { status: 503, json: { error: 'off' } });
      assert.deepEqual(await comment(b, { body: 'x' }), { status: 503, json: { error: 'off' } });
    }, { withService: false }));
});

describe('#533/AC-4 only the /ui, JSON, bounded, on the exact path', () => {
  test('#533/AC-4 another Origin, no Origin, a look-alike Host, a query, a trailing slash or an encoded path is 403 and nothing is written', async () =>
    withApi(async (b) => {
      const body = { repo: REPO, number: 533, labels: ['frontend'] };
      for (const path of [WORK_ISSUE_ROUTE, WORK_ISSUE_COMMENTS_ROUTE]) {
        const method = path === WORK_ISSUE_ROUTE ? 'PATCH' : 'POST';
        const payload = path === WORK_ISSUE_ROUTE ? body : { repo: REPO, number: 533, body: 'x' };
        assert.equal((await send(b, method, path, payload, { origin: 'http://evil.example' })).status, 403, `${path} evil`);
        assert.equal((await send(b, method, path, payload, { origin: `http://${b.host}.example.com` })).status, 403, `${path} lookalike`);
        const noOrigin = await fetch(`${b.api.url}${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
        assert.equal(noOrigin.status, 403, `${path} no origin`);
        assert.equal((await send(b, method, `${path}?x=1`, payload)).status, 403, `${path} query`);
        assert.equal((await send(b, method, `${path}/`, payload)).status, 403, `${path} slash`);
        assert.equal((await send(b, method, path.replace('/work/issue', '/work%2Fissue'), payload)).status, 403, `${path} encoded`);
      }
      assert.equal(b.github.calls, 0);
      assert.deepEqual(b.github.writes, []);
    }));

  test('#533/AC-4 Given a non-JSON body, Then 415; malformed JSON 400; a body over the bound 413; nothing is written', async () =>
    withApi(async (b) => {
      for (const path of [WORK_ISSUE_ROUTE, WORK_ISSUE_COMMENTS_ROUTE]) {
        const method = path === WORK_ISSUE_ROUTE ? 'PATCH' : 'POST';
        assert.equal((await send(b, method, path, 'title=x', { 'content-type': 'text/plain' })).status, 415, `${path} text`);
        assert.equal((await send(b, method, path, '{not json')).status, 400, `${path} malformed`);
        assert.equal((await send(b, method, path, JSON.stringify({ repo: REPO, number: 533, body: 'x'.repeat(400_000) }))).status, 413, `${path} large`);
      }
      assert.equal(b.github.calls, 0);
    }));

  test('#533/AC-4 a value over GitHub limits, a bad repo or number, a non-array labels or an empty edit is 400 bad-param', async () =>
    withApi(async (b) => {
      assert.deepEqual(await patch(b, { title: 'x'.repeat(257), updatedAt: OPENED_AT }), { status: 400, json: { error: 'bad-param', param: 'title' } });
      assert.deepEqual(await patch(b, { title: '', updatedAt: OPENED_AT }), { status: 400, json: { error: 'bad-param', param: 'title' } });
      assert.deepEqual(await patch(b, { body: 'x'.repeat(65_537), updatedAt: OPENED_AT }), { status: 400, json: { error: 'bad-param', param: 'body' } });
      assert.deepEqual(await patch(b, { labels: 'backend' }), { status: 400, json: { error: 'bad-param', param: 'labels' } });
      assert.deepEqual(await patch(b, { parent: 'nope' }), { status: 400, json: { error: 'bad-param', param: 'parent' } });
      assert.deepEqual(await patch(b, { repo: 'nope', labels: [] }), { status: 400, json: { error: 'bad-param', param: 'repo' } });
      assert.deepEqual(await patch(b, { number: 0, labels: [] }), { status: 400, json: { error: 'bad-param', param: 'number' } });
      assert.deepEqual(await patch(b, {}), { status: 400, json: { error: 'bad-param', param: 'edit' } });
      assert.equal(b.github.calls, 0);
    }));

  test('#533/AC-4 a parent saves on its own: with any other field it is 400 bad-param parent and nothing is written', async () =>
    withApi(async (b) => {
      assert.deepEqual(await patch(b, { parent: `${REPO}#478`, labels: ['backend'] }), { status: 400, json: { error: 'bad-param', param: 'parent' } });
      assert.deepEqual(await patch(b, { parent: null, title: 'x', updatedAt: OPENED_AT }), { status: 400, json: { error: 'bad-param', param: 'parent' } });
      assert.equal(b.github.calls, 0);
      assert.deepEqual(b.github.writes, []);
    }));

  test('#533/AC-4 the remaining bad values', async () =>
    withApi(async (b) => {
      assert.deepEqual(await comment(b, { body: '' }), { status: 400, json: { error: 'bad-param', param: 'body' } });
      assert.deepEqual(await comment(b, { body: 'x'.repeat(65_537) }), { status: 400, json: { error: 'bad-param', param: 'body' } });
      assert.equal(b.github.calls, 0);
    }));

  test("#533/AC-4 a method that is not the route's own never gets past the origin gate", async () =>
    withApi(async (b) => {
      assert.equal((await send(b, 'POST', WORK_ISSUE_ROUTE, {})).status, 403, 'POST on the PATCH route never gets past the origin gate');
      const r = await send(b, 'PATCH', WORK_ISSUE_COMMENTS_ROUTE, {});
      assert.equal(r.status, 403);
      assert.equal(b.github.calls, 0);
    }));
});
