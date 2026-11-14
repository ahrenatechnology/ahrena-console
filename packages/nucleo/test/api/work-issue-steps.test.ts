import { OWNER_TOKEN, ownerFetch as fetch } from '../owner-http.ts';
/*
 * #534 the Plan steps of the work board's issue through the HTTP routes: the core's real server, the use case,
 * the ADR-0001 cache and the GraphQL adapter; GitHub is a fake `fetch` that holds one issue with its sub-issues
 * and records what is written. Each scenario names the acceptance criterion it covers.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Accounts, MontadorDoPainel, startLocalApi, type LocalApi } from '../../src/api/index.ts';
import { WORK_ISSUE_ROUTE } from '../../src/api/work-issue.ts';
import { WORK_ISSUE_STEPS_ORDER_ROUTE, WORK_ISSUE_STEPS_RESTORE_ROUTE, WORK_ISSUE_STEPS_ROUTE } from '../../src/api/work-issue-steps.ts';
import { GithubCache, MemoryCacheStore } from '../../src/github/cache.ts';
import { GithubGraphqlSource } from '../../src/github/github-source.ts';
import { WorkIssueService } from '../../src/github/work-issue-service.ts';
import { clock, REPO } from '../github/helpers.ts';

const OPENED_AT = '2026-11-10T10:00:00Z';
const X = 534;

interface Sub {
  number: number;
  title: string;
  body: string;
  updatedAt: string;
  type: string | null;
  state: 'OPEN' | 'CLOSED';
  stateReason: string | null;
}

interface Github {
  calls: number;
  /** #534 the mutations the fake applied, in order, with their input. */
  writes: { op: string; input: any }[];
  mode: 'ok' | 'down' | 'forbidden' | 'unread' | 'missing';
  types: { id: string; name: string }[];
  subs: Sub[];
  secret: string;
}

const sub = (number: number, title: string, over: Partial<Sub> = {}): Sub => ({ number, title, body: `${title} body`, updatedAt: OPENED_AT, type: 'Plan', state: 'OPEN', stateReason: null, ...over });
const ref = (s: Sub) => ({
  updatedAt: s.updatedAt, number: s.number, title: s.title, url: `https://github.com/${REPO}/issues/${s.number}`, state: s.state, stateReason: s.stateReason,
  repository: { nameWithOwner: REPO }, issueType: s.type ? { name: s.type } : null,
});
const detail = (g: Github) => ({
  ...ref(sub(X, 'the issue')), updatedAt: OPENED_AT, body: 'the body', labels: { nodes: [] }, milestone: null,
  comments: { totalCount: 0, nodes: [] }, parent: null, subIssues: { nodes: g.subs.map(ref) }, closedByPullRequestsReferences: { nodes: [] },
});

interface Boot { api: LocalApi; github: Github; logs: string[]; host: string; close(): Promise<void> }

async function boot({ withService = true }: { withService?: boolean } = {}): Promise<Boot> {
  const storage = openSqliteStorage({ path: ':memory:' });
  const github: Github = {
    calls: 0, writes: [], mode: 'ok', secret: 'raw-github-text-never-on-screen',
    types: [{ id: 'T_task', name: 'Tech Task' }, { id: 'T_plan', name: 'Plan' }],
    subs: [sub(601, 'step A'), sub(602, 'step B'), sub(603, 'step C'), sub(604, 'a task', { type: 'Tech Task' }), sub(605, 'step D, removed', { state: 'CLOSED', stateReason: 'NOT_PLANNED' })],
  };
  const fakeFetch = (async (_u: string, init: RequestInit) => {
    github.calls++;
    if (github.mode === 'down') throw new TypeError(github.secret);
    const { query, variables } = JSON.parse(String(init.body));
    const op = /(?:query|mutation) (\w+)/.exec(query)![1];
    if (github.mode === 'unread' && op === 'WorkIssue') throw new TypeError(github.secret);
    const isWrite = /^(Update|Create|Close|Reopen|Move)/.test(op);
    if (isWrite && github.mode === 'forbidden') return new Response(JSON.stringify({ message: github.secret }), { status: 403 });
    const byId = (id: string) => github.subs.find((s) => `I_${s.number}` === id)!;
    let data: Record<string, unknown> = {};
    if (op === 'WorkIssue') data = { repository: { issue: detail(github) } };
    else if (op === 'WorkIssueId') data = { repository: { issue: { id: `I_${variables.n}` } } };
    else if (op === 'WorkPlanSteps') {
      data = {
        repository: github.mode === 'missing' ? null : {
          id: 'R_1', issueTypes: { nodes: github.types },
          issue: { id: `I_${X}`, subIssues: { nodes: github.subs.map((s) => ({ id: `I_${s.number}`, ...ref(s), body: s.body, updatedAt: s.updatedAt })) } },
        },
      };
    } else if (op === 'UpdateWorkIssue') {
      const s = byId(variables.input.id);
      if (variables.input.title !== undefined) s.title = variables.input.title;
      if (variables.input.body !== undefined) s.body = variables.input.body;
      s.updatedAt = '2026-11-12T12:00:00Z';
      github.writes.push({ op, input: variables.input });
    } else if (op === 'CreateWorkPlanStep') {
      const i = variables.input;
      github.subs.push(sub(700, i.title, { body: i.body ?? '', type: i.issueTypeId === 'T_plan' ? 'Plan' : 'Tech Task' }));
      github.writes.push({ op, input: i });
    } else if (op === 'CloseWorkPlanStep') {
      const s = byId(variables.input.issueId);
      s.state = 'CLOSED';
      s.stateReason = variables.input.stateReason;
      github.writes.push({ op, input: variables.input });
    } else if (op === 'ReopenWorkPlanStep') {
      const s = byId(variables.input.issueId);
      s.state = 'OPEN';
      s.stateReason = null;
      github.writes.push({ op, input: variables.input });
    } else if (op === 'MoveWorkPlanStep') {
      const i = variables.input;
      const moving = github.subs.splice(github.subs.indexOf(byId(i.subIssueId)), 1)[0]!;
      const at = i.afterId ? github.subs.indexOf(byId(i.afterId)) + 1 : github.subs.indexOf(byId(i.beforeId));
      github.subs.splice(at, 0, moving);
      github.writes.push({ op, input: i });
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
const call = async (b: Boot, method: string, path: string, body: Record<string, unknown>) => {
  const r = await send(b, method, path, { repo: REPO, number: X, ...body });
  return { status: r.status, json: (await r.json()) as any };
};
const edit = (b: Boot, body: Record<string, unknown>) => call(b, 'PATCH', WORK_ISSUE_STEPS_ROUTE, body);
const add = (b: Boot, body: Record<string, unknown>) => call(b, 'POST', WORK_ISSUE_STEPS_ROUTE, body);
const remove = (b: Boot, body: Record<string, unknown>) => call(b, 'DELETE', WORK_ISSUE_STEPS_ROUTE, body);
const restore = (b: Boot, body: Record<string, unknown>) => call(b, 'POST', WORK_ISSUE_STEPS_RESTORE_ROUTE, body);
const move = (b: Boot, body: Record<string, unknown>) => call(b, 'POST', WORK_ISSUE_STEPS_ORDER_ROUTE, body);
const getIssue = async (b: Boot) => (await (await fetch(`${b.api.url}${WORK_ISSUE_ROUTE}?repo=${REPO}&number=${X}`)).json()) as any;
const key = (n: number) => `${REPO}#${n}`;
const titles = (json: any) => json.plan.steps.map((s: any) => s.title);

describe('#534/AC-1 a step is edited on GitHub and the answer carries the plan as GitHub returned it', () => {
  test("#534/AC-1 Given a step's title and body saved at the updatedAt the /ui read, Then GitHub holds them and the answer's plan has the new title, held by the cache", async () =>
    withApi(async (b) => {
      const r = await edit(b, { step: key(601), title: 'step A, edited', body: 'new body', updatedAt: OPENED_AT });
      assert.equal(r.status, 200);
      assert.deepEqual([r.json.number, r.json.stale, titles(r.json)], [X, false, ['step A, edited', 'step B', 'step C']]);
      assert.deepEqual(b.github.writes.map((w) => [w.op, w.input.id, w.input.title, w.input.body]), [['UpdateWorkIssue', 'I_601', 'step A, edited', 'new body']]);
      const calls = b.github.calls;
      assert.deepEqual([titles(await getIssue(b)), b.github.calls], [['step A, edited', 'step B', 'step C'], calls]);
    }));

  test("#534/AC-1 Given the step was edited on GitHub after the /ui read, Then nothing is written and 409 carries GitHub's title, body and updatedAt of the step", async () =>
    withApi(async (b) => {
      b.github.subs[0]!.title = 'edited on github';
      b.github.subs[0]!.updatedAt = '2026-11-11T09:00:00Z';
      const r = await edit(b, { step: key(601), title: 'mine', updatedAt: OPENED_AT });
      assert.deepEqual([r.status, r.json], [409, { error: 'conflict', title: 'edited on github', body: 'step A body', updatedAt: '2026-11-11T09:00:00Z' }]);
      assert.deepEqual(b.github.writes, []);
    }));

  test('#534/AC-1 a step that is not a Plan sub-issue of the issue is 422 unknown-value step, and nothing is written', async () =>
    withApi(async (b) => {
      for (const step of [key(604), key(999)]) {
        assert.deepEqual(await edit(b, { step, title: 'x', updatedAt: OPENED_AT }), { status: 422, json: { error: 'unknown-value', param: 'step' } });
      }
      assert.deepEqual(b.github.writes, []);
    }));

  test('#534/AC-1 an edit with neither title nor body, a bad step or no valid updatedAt is 400 bad-param', async () =>
    withApi(async (b) => {
      assert.deepEqual(await edit(b, { step: key(601), updatedAt: OPENED_AT }), { status: 400, json: { error: 'bad-param', param: 'edit' } });
      assert.deepEqual(await edit(b, { step: 'nope', title: 'x', updatedAt: OPENED_AT }), { status: 400, json: { error: 'bad-param', param: 'step' } });
      assert.deepEqual(await edit(b, { title: 'x', updatedAt: OPENED_AT }), { status: 400, json: { error: 'bad-param', param: 'step' } });
      assert.deepEqual(await edit(b, { step: key(601), title: 'x' }), { status: 400, json: { error: 'bad-param', param: 'updatedAt' } });
      assert.deepEqual(await edit(b, { step: key(601), title: '', updatedAt: OPENED_AT }), { status: 400, json: { error: 'bad-param', param: 'title' } });
      assert.deepEqual(await edit(b, { step: key(601), title: 'x'.repeat(257), updatedAt: OPENED_AT }), { status: 400, json: { error: 'bad-param', param: 'title' } });
      assert.deepEqual(await edit(b, { step: key(601), body: 'x'.repeat(65_537), updatedAt: OPENED_AT }), { status: 400, json: { error: 'bad-param', param: 'body' } });
      assert.equal(b.github.calls, 0);
    }));
});

describe('#534/AC-2 a new step is created as a Plan sub-issue of the issue, at the end of the plan', () => {
  test("#534/AC-2 Given a title and a body, Then one createIssue carries the Plan type and the parent as variables and the answer's plan ends with the step", async () =>
    withApi(async (b) => {
      const r = await add(b, { title: 'step D', body: 'about D' });
      assert.equal(r.status, 200);
      assert.deepEqual(titles(r.json), ['step A', 'step B', 'step C', 'step D']);
      assert.deepEqual(b.github.writes.map((w) => w.op), ['CreateWorkPlanStep']);
      assert.deepEqual(b.github.writes[0]!.input, { repositoryId: 'R_1', title: 'step D', body: 'about D', issueTypeId: 'T_plan', parentIssueId: `I_${X}` });
    }));

  test('#534/AC-2 Given only a title, Then the step is created with an empty body', async () =>
    withApi(async (b) => {
      assert.equal((await add(b, { title: 'step D' })).status, 200);
      assert.equal(b.github.writes[0]!.input.body, '');
    }));

  test('#534/AC-2 a repository with no Plan issue type is 422 unknown-value type and nothing is written; a blank title is 400 bad-param title', async () =>
    withApi(async (b) => {
      b.github.types = [{ id: 'T_task', name: 'Tech Task' }];
      assert.deepEqual(await add(b, { title: 'step D' }), { status: 422, json: { error: 'unknown-value', param: 'type' } });
      assert.deepEqual(b.github.writes, []);
      assert.deepEqual(await add(b, { title: '  ' }), { status: 400, json: { error: 'bad-param', param: 'title' } });
      assert.deepEqual(await add(b, { title: 'x', body: 7 }), { status: 400, json: { error: 'bad-param', param: 'body' } });
    }));
});

describe('#534/AC-3 reordering moves the sub-issue on GitHub and the plan comes back in the new order', () => {
  test('#534/AC-3 Given steps A, B, C, when C moves after A, Then GitHub reprioritizes with afterId and the plan is A, C, B', async () =>
    withApi(async (b) => {
      const r = await move(b, { step: key(603), after: key(601) });
      assert.deepEqual([r.status, titles(r.json)], [200, ['step A', 'step C', 'step B']]);
      assert.deepEqual(b.github.writes, [{ op: 'MoveWorkPlanStep', input: { issueId: `I_${X}`, subIssueId: 'I_603', afterId: 'I_601' } }]);
    }));

  test('#534/AC-3 Given after is null, Then the step goes to the top, with beforeId of the first sub-issue', async () =>
    withApi(async (b) => {
      const r = await move(b, { step: key(603), after: null });
      assert.deepEqual([r.status, titles(r.json)], [200, ['step C', 'step A', 'step B']]);
      assert.deepEqual(b.github.writes[0]!.input, { issueId: `I_${X}`, subIssueId: 'I_603', beforeId: 'I_601' });
    }));

  test('#534/AC-3 a step already on top moved to the top writes nothing and answers the plan as it is', async () =>
    withApi(async (b) => {
      const r = await move(b, { step: key(601), after: null });
      assert.deepEqual([r.status, titles(r.json), b.github.writes], [200, ['step A', 'step B', 'step C'], []]);
    }));

  test('#534/AC-3 a step or an after that is not a sub-issue of the issue is 422 with its param; a missing after, itself or a bad key is 400 bad-param after', async () =>
    withApi(async (b) => {
      assert.deepEqual(await move(b, { step: key(604), after: key(601) }), { status: 422, json: { error: 'unknown-value', param: 'step' } });
      assert.deepEqual(await move(b, { step: key(603), after: key(999) }), { status: 422, json: { error: 'unknown-value', param: 'after' } });
      assert.deepEqual(await move(b, { step: key(603) }), { status: 400, json: { error: 'bad-param', param: 'after' } });
      assert.deepEqual(await move(b, { step: key(603), after: key(603) }), { status: 400, json: { error: 'bad-param', param: 'after' } });
      assert.deepEqual(await move(b, { step: key(603), after: 'nope' }), { status: 400, json: { error: 'bad-param', param: 'after' } });
      assert.deepEqual(await move(b, { step: 'nope', after: null }), { status: 400, json: { error: 'bad-param', param: 'step' } });
      assert.deepEqual(b.github.writes, []);
    }));
});

describe('#534/AC-4 removing a step closes its sub-issue as not planned and the plan count drops by one', () => {
  test('#534/AC-4 Given steps A and B and C, when B is removed, Then GitHub closes it with NOT_PLANNED, plan.count is 2 and subIssues still lists it', async () =>
    withApi(async (b) => {
      const r = await remove(b, { step: key(602) });
      assert.equal(r.status, 200);
      assert.deepEqual([r.json.plan.count, titles(r.json)], [2, ['step A', 'step C']]);
      assert.deepEqual(b.github.writes, [{ op: 'CloseWorkPlanStep', input: { issueId: 'I_602', stateReason: 'NOT_PLANNED' } }]);
      const listed = r.json.subIssues.find((s: any) => s.number === 602);
      assert.deepEqual([listed.state, listed.stateReason], ['CLOSED', 'NOT_PLANNED']);
    }));

  test('#534/AC-4 a step closed as completed stays in the plan; one closed as not planned is no step', async () =>
    withApi(async (b) => {
      b.github.subs[0]!.state = 'CLOSED';
      b.github.subs[0]!.stateReason = 'COMPLETED';
      b.github.subs[1]!.state = 'CLOSED';
      b.github.subs[1]!.stateReason = 'NOT_PLANNED';
      const g = await getIssue(b);
      assert.deepEqual([g.plan.count, titles(g)], [2, ['step A', 'step C']]);
    }));

  test('#534/AC-4 a step that is not a Plan sub-issue of the issue is 422 unknown-value step, and an already removed step too', async () =>
    withApi(async (b) => {
      assert.deepEqual(await remove(b, { step: key(604) }), { status: 422, json: { error: 'unknown-value', param: 'step' } });
      assert.equal((await remove(b, { step: key(602) })).status, 200);
      assert.deepEqual(await remove(b, { step: key(602) }), { status: 422, json: { error: 'unknown-value', param: 'step' } });
      assert.deepEqual(await remove(b, { step: 'nope' }), { status: 400, json: { error: 'bad-param', param: 'step' } });
      assert.equal(b.github.writes.length, 1);
    }));
});

describe('#534/AC-4 a removed step is restored: its sub-issue is reopened and the plan count goes up by one', () => {
  test('#534/AC-4 Given step B removed, when it is restored, Then GitHub reopens it, the answer has it back in plan.steps with count 3, and the cache holds that answer', async () =>
    withApi(async (b) => {
      assert.equal((await remove(b, { step: key(602) })).status, 200);
      const r = await restore(b, { step: key(602) });
      assert.equal(r.status, 200);
      assert.deepEqual([r.json.plan.count, titles(r.json)], [3, ['step A', 'step B', 'step C']]);
      assert.deepEqual(b.github.writes.at(-1), { op: 'ReopenWorkPlanStep', input: { issueId: 'I_602' } });
      const calls = b.github.calls;
      assert.deepEqual([titles(await getIssue(b)), b.github.calls], [['step A', 'step B', 'step C'], calls]);
    }));

  test('#534/AC-4 Given a step that is open or closed as completed, Then 409 not-removed and nothing is written', async () =>
    withApi(async (b) => {
      b.github.subs[1]!.state = 'CLOSED';
      b.github.subs[1]!.stateReason = 'COMPLETED';
      for (const n of [601, 602]) assert.deepEqual(await restore(b, { step: key(n) }), { status: 409, json: { error: 'not-removed' } });
      assert.deepEqual(b.github.writes, []);
    }));

  test('#534/AC-4 Given a step that is not a Plan sub-issue of the issue, Then 422 unknown-value step; a bad step is 400 bad-param step; nothing is written', async () =>
    withApi(async (b) => {
      b.github.subs[3]!.state = 'CLOSED';
      b.github.subs[3]!.stateReason = 'NOT_PLANNED';
      for (const step of [key(604), key(999)]) assert.deepEqual(await restore(b, { step }), { status: 422, json: { error: 'unknown-value', param: 'step' } });
      assert.deepEqual(await restore(b, { step: 'nope' }), { status: 400, json: { error: 'bad-param', param: 'step' } });
      assert.deepEqual(b.github.writes, []);
    }));
});

describe('#534/AC-1 each plan step carries the updatedAt the /ui sends to the edit', () => {
  test('#534/AC-1 Given GitHub holds a step updatedAt, Then GET plan.steps carries it and an edit with it is accepted', async () =>
    withApi(async (b) => {
      const g = await getIssue(b);
      assert.deepEqual(g.plan.steps.map((s: any) => s.updatedAt), [OPENED_AT, OPENED_AT, OPENED_AT]);
      assert.equal((await edit(b, { step: key(601), title: 'edited', updatedAt: g.plan.steps[0].updatedAt })).status, 200);
    }));
});

const all: [string, (b: Boot) => ReturnType<typeof call>][] = [
  ['edit', (b) => edit(b, { step: key(601), title: 'x', updatedAt: OPENED_AT })],
  ['add', (b) => add(b, { title: 'x' })],
  ['remove', (b) => remove(b, { step: key(601) })],
  ['move', (b) => move(b, { step: key(603), after: null })],
  ['restore', (b) => restore(b, { step: key(605) })],
];

describe('#534/AC-5 a GitHub refusal answers with a stable reason and leaves the cache as it was', () => {
  test('#534/AC-5 Given GitHub refuses the write (403), Then each route is 502 github-refused with reason no-permission, the raw text only in the log, and the cache still serves the old plan', async () =>
    withApi(async (b) => {
      await getIssue(b);
      b.github.mode = 'forbidden';
      for (const [name, run] of all) {
        const r = await run(b);
        assert.deepEqual([r.status, r.json], [502, { error: 'github-refused', reason: 'no-permission' }], name);
        assert.ok(!JSON.stringify(r.json).includes(b.github.secret));
      }
      assert.ok(b.logs.some((l) => l.includes(b.github.secret)));
      b.github.mode = 'ok';
      const calls = b.github.calls;
      assert.deepEqual([titles(await getIssue(b)), b.github.calls], [['step A', 'step B', 'step C'], calls]);
    }));

  test('#534/AC-5 Given GitHub is unreachable, Then each route is 502 github-unavailable with reason network and no GitHub text', async () =>
    withApi(async (b) => {
      b.github.mode = 'down';
      for (const [name, run] of all) {
        const r = await run(b);
        assert.deepEqual([r.status, r.json], [502, { error: 'github-unavailable', reason: 'network' }], name);
      }
    }));

  test('#534/AC-5 Given the write was applied and the read-back fails, Then 502 written-unread, and the next GET re-reads GitHub (the new plan, not the cached one)', async () =>
    withApi(async (b) => {
      await getIssue(b);
      b.github.mode = 'unread';
      const r = await remove(b, { step: key(602) });
      assert.deepEqual([r.status, r.json], [502, { error: 'written-unread', reason: 'network' }]);
      assert.ok(!JSON.stringify(r.json).includes(b.github.secret));
      assert.ok(b.logs.some((l) => l.includes(b.github.secret)));
      b.github.mode = 'ok';
      assert.deepEqual(titles(await getIssue(b)), ['step A', 'step C']);
    }));

  test('#534/AC-5 no such issue is 404 not-found; --no-github (no service) is 503 off for each route', async () => {
    await withApi(async (b) => {
      b.github.mode = 'missing';
      for (const [name, run] of all) assert.deepEqual((await run(b)).json, { error: 'not-found' }, name);
    });
    await withApi(async (b) => {
      for (const [name, run] of all) assert.deepEqual(await run(b), { status: 503, json: { error: 'off' } }, name);
    }, { withService: false });
  });
});

describe('#534/AC-5 only the /ui, JSON, bounded, on the exact path', () => {
  const routes: [string, string, Record<string, unknown>][] = [
    ['PATCH', WORK_ISSUE_STEPS_ROUTE, { repo: REPO, number: X, step: key(601), title: 'x', updatedAt: OPENED_AT }],
    ['POST', WORK_ISSUE_STEPS_ROUTE, { repo: REPO, number: X, title: 'x' }],
    ['DELETE', WORK_ISSUE_STEPS_ROUTE, { repo: REPO, number: X, step: key(601) }],
    ['POST', WORK_ISSUE_STEPS_ORDER_ROUTE, { repo: REPO, number: X, step: key(603), after: null }],
    ['POST', WORK_ISSUE_STEPS_RESTORE_ROUTE, { repo: REPO, number: X, step: key(601) }],
  ];

  test('#534/AC-5 another Origin, no Origin, a look-alike Host, a query, a trailing slash or an encoded path is 403 and nothing is written', async () =>
    withApi(async (b) => {
      for (const [method, path, payload] of routes) {
        const at = `${method} ${path}`;
        assert.equal((await send(b, method, path, payload, { origin: 'http://evil.example' })).status, 403, `${at} evil`);
        assert.equal((await send(b, method, path, payload, { origin: `http://${b.host}.example.com` })).status, 403, `${at} lookalike`);
        const noOrigin = await fetch(`${b.api.url}${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
        assert.equal(noOrigin.status, 403, `${at} no origin`);
        assert.equal((await send(b, method, path, payload, { 'sec-fetch-site': 'cross-site' })).status, 403, `${at} cross-site`);
        assert.equal((await send(b, method, `${path}?x=1`, payload)).status, 403, `${at} query`);
        assert.equal((await send(b, method, `${path}/`, payload)).status, 403, `${at} slash`);
        assert.equal((await send(b, method, path.replace('/work/issue', '/work%2Fissue'), payload)).status, 403, `${at} encoded`);
      }
      assert.equal(b.github.calls, 0);
      assert.deepEqual(b.github.writes, []);
    }));

  test("#534/AC-5 a method that is not the route's own never gets past the origin gate", async () =>
    withApi(async (b) => {
      assert.equal((await fetch(`${b.api.url}${WORK_ISSUE_STEPS_ROUTE}`, { headers: { origin: `http://${b.host}` } })).status, 403);
      assert.equal((await send(b, 'PUT', WORK_ISSUE_STEPS_ROUTE, {})).status, 403);
      assert.equal((await send(b, 'PATCH', WORK_ISSUE_STEPS_ORDER_ROUTE, {})).status, 403);
      assert.equal((await send(b, 'DELETE', WORK_ISSUE_STEPS_ORDER_ROUTE, {})).status, 403);
      assert.equal((await send(b, 'PATCH', WORK_ISSUE_STEPS_RESTORE_ROUTE, {})).status, 403);
      assert.equal((await send(b, 'DELETE', WORK_ISSUE_STEPS_RESTORE_ROUTE, {})).status, 403);
      assert.equal(b.github.calls, 0);
    }));

  test('#534/AC-5 Given a non-JSON body, Then 415; malformed JSON 400; a body over the bound 413; a bad repo or number 400 bad-param; nothing is written', async () =>
    withApi(async (b) => {
      for (const [method, path, payload] of routes) {
        const at = `${method} ${path}`;
        assert.equal((await send(b, method, path, 'title=x', { 'content-type': 'text/plain' })).status, 415, `${at} text`);
        assert.equal((await send(b, method, path, '{not json')).status, 400, `${at} malformed`);
        assert.equal((await send(b, method, path, JSON.stringify({ ...payload, title: 'x'.repeat(400_000) }))).status, 413, `${at} large`);
        const bad = await send(b, method, path, { ...payload, repo: 'nope' });
        assert.deepEqual([bad.status, await bad.json()], [400, { error: 'bad-param', param: 'repo' }], `${at} repo`);
        const zero = await send(b, method, path, { ...payload, number: 0 });
        assert.deepEqual([zero.status, await zero.json()], [400, { error: 'bad-param', param: 'number' }], `${at} number`);
      }
      assert.equal(b.github.calls, 0);
    }));
});
