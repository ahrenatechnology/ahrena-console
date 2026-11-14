/*
 * #534 the GraphQL adapter of the Plan steps and the read change behind them: it checks the step against a
 * fresh read of the issue's sub-issues before it writes, sends every user value as a variable, never retries a
 * mutation, and answers with the issue as GitHub returns it. GitHub is a fake `fetch`.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { GithubGraphqlSource, QUERIES } from '../../src/github/github-source.ts';
import { buildWorkIssue, WorkIssueNotRemovedError, WorkIssueRefusedError, WorkIssueWrittenUnreadError, type WorkIssueRef, type WorkIssueRead } from '../../src/github/work-issue.ts';
import { k, REPO } from './helpers.ts';

const node = (n: number, over: Record<string, unknown> = {}) => ({
  id: `I_${n}`, number: n, title: `step ${n}`, body: `body ${n}`, updatedAt: '2026-11-10T10:00:00Z', url: `https://github.com/${REPO}/issues/${n}`, state: 'OPEN', stateReason: null,
  repository: { nameWithOwner: REPO }, issueType: { name: 'Plan' }, ...over,
});

interface Call { operation: string; query: string; variables: any }

function fake({ subs = [node(601), node(602)], types = [{ id: 'T_plan', name: 'Plan' }], failOn }: { subs?: unknown[]; types?: unknown[]; failOn?: string } = {}) {
  const calls: Call[] = [];
  const f = (async (_u: string, init: RequestInit) => {
    const { query, variables } = JSON.parse(String(init.body));
    const operation = /(?:query|mutation) (\w+)/.exec(query)![1];
    calls.push({ operation, query, variables });
    if (failOn === operation) return new Response(JSON.stringify({ message: 'raw github text' }), { status: failOn === 'WorkIssue' ? 500 : 502 });
    let data: Record<string, unknown> = {};
    if (operation === 'WorkPlanSteps') data = { repository: { id: 'R_1', issueTypes: { nodes: types }, issue: { id: 'I_534', subIssues: { nodes: subs } } } };
    else if (operation === 'WorkIssueId') data = { repository: { issue: { id: `I_${variables.n}` } } };
    else if (operation === 'WorkIssue') {
      data = { repository: { issue: { number: 534, title: 'x', url: 'u', state: 'OPEN', updatedAt: 't', repository: { nameWithOwner: REPO }, issueType: { name: 'Plan' }, body: '', labels: { nodes: [] }, milestone: null, comments: { totalCount: 0, nodes: [] }, parent: null, subIssues: { nodes: subs }, closedByPullRequestsReferences: { nodes: [] } } } };
    }
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, source: new GithubGraphqlSource({ token: 'test-token', fetch: f, sleep: async () => {} }) };
}

describe('#534/AC-4 the read carries each sub-issue stateReason and a removed step is no step', () => {
  test('#534/AC-4 the issue read maps stateReason of each sub-issue', async () => {
    const { source } = fake({ subs: [node(601, { state: 'CLOSED', stateReason: 'NOT_PLANNED' }), node(602)] });
    const r = (await source.issue(k(534)))!;
    assert.deepEqual(r.subIssues.map((s) => [s.number, s.stateReason]), [[601, 'NOT_PLANNED'], [602, null]]);
    assert.match(QUERIES.issue, /stateReason/);
  });

  test('#534/AC-4 buildWorkIssue leaves a Plan sub-issue closed as not planned out of plan.steps and plan.count, and keeps subIssues complete', () => {
    const ref = (n: number, over: Partial<WorkIssueRef> = {}): WorkIssueRef => ({ key: k(n), repo: REPO, number: n, title: `s${n}`, url: 'u', state: 'OPEN', type: 'Plan', ...over });
    const read = { ...ref(534), updatedAt: 't', labels: [], milestone: null, body: '', comments: [], commentsTotal: 0, parentChain: [], pullRequests: [],
      subIssues: [ref(1), ref(2, { state: 'CLOSED', stateReason: 'NOT_PLANNED' }), ref(3, { state: 'CLOSED', stateReason: 'COMPLETED' }), ref(4, { type: 'Tech Task', state: 'CLOSED', stateReason: 'NOT_PLANNED' })] } as WorkIssueRead;
    const v = buildWorkIssue(read, null);
    assert.deepEqual([v.plan.count, v.plan.steps.map((s) => s.number)], [2, [1, 3]]);
    assert.deepEqual(v.subIssues.map((s) => s.number), [1, 2, 3, 4]);
  });
});

describe('#534/AC-1 stepCurrent and editStep', () => {
  test("#534/AC-1 stepCurrent answers the step's title, body and updatedAt from one fresh read of the issue's sub-issues; null for an unknown issue", async () => {
    const { source, calls } = fake();
    assert.deepEqual(await source.stepCurrent(k(534), k(602)), { title: 'step 602', body: 'body 602', updatedAt: '2026-11-10T10:00:00Z' });
    assert.deepEqual(calls.map((c) => c.operation), ['WorkPlanSteps']);
    assert.deepEqual(calls[0]!.variables, { o: 'ahrenatechnology', r: 'ahrena-console', n: 534 });
  });

  test('#534/AC-1 stepCurrent refuses a step that is not a Plan sub-issue (another type, absent, removed) with WorkIssueRefusedError step', async () => {
    const { source } = fake({ subs: [node(601, { issueType: { name: 'Tech Task' } }), node(602, { state: 'CLOSED', stateReason: 'NOT_PLANNED' })] });
    for (const step of [k(601), k(602), k(999)]) await assert.rejects(source.stepCurrent(k(534), step), (e: any) => e instanceof WorkIssueRefusedError && e.param === 'step');
  });

  test('#534/AC-1 editStep sends one updateIssue with the step id and the values as variables, then reads the issue back', async () => {
    const { source, calls } = fake();
    await source.editStep(k(534), k(601), { title: 'T', body: 'B' });
    assert.deepEqual(calls.map((c) => c.operation), ['WorkPlanSteps', 'UpdateWorkIssue', 'WorkIssue']);
    assert.deepEqual(calls[1]!.variables.input, { id: 'I_601', title: 'T', body: 'B' });
    assert.ok(!calls[1]!.query.includes('"T"'));
  });

  test('#534/AC-1 editStep on a step that is not a Plan sub-issue (another type, removed, absent) is WorkIssueRefusedError step and sends no mutation', async () => {
    const { source, calls } = fake({ subs: [node(601, { issueType: { name: 'Tech Task' } }), node(602, { state: 'CLOSED', stateReason: 'NOT_PLANNED' })] });
    for (const step of [k(601), k(602), k(999)]) await assert.rejects(source.editStep(k(534), step, { title: 'T' }), (e: any) => e instanceof WorkIssueRefusedError && e.param === 'step');
    assert.ok(calls.every((c) => c.operation === 'WorkPlanSteps'));
  });
});

describe('#534/AC-2 addStep', () => {
  test('#534/AC-2 one createIssue with the repository, the Plan type and the parent as variables', async () => {
    const { source, calls } = fake();
    await source.addStep(k(534), { title: 'new', body: 'text' });
    assert.deepEqual(calls.map((c) => c.operation), ['WorkPlanSteps', 'CreateWorkPlanStep', 'WorkIssue']);
    assert.deepEqual(calls[1]!.variables.input, { repositoryId: 'R_1', title: 'new', body: 'text', issueTypeId: 'T_plan', parentIssueId: 'I_534' });
    assert.match(calls[1]!.query, /createIssue/);
  });

  test('#534/AC-2 no Plan type is WorkIssueRefusedError type and nothing is written', async () => {
    const { source, calls } = fake({ types: [{ id: 'T_task', name: 'Tech Task' }] });
    await assert.rejects(source.addStep(k(534), { title: 'new', body: '' }), (e: any) => e instanceof WorkIssueRefusedError && e.param === 'type');
    assert.deepEqual(calls.map((c) => c.operation), ['WorkPlanSteps']);
  });
});

describe('#534/AC-3 moveStep', () => {
  test('#534/AC-3 after: reprioritizeSubIssue with afterId; null: beforeId of the first sub-issue; already first: no write', async () => {
    const a = fake();
    await a.source.moveStep(k(534), k(602), k(601));
    assert.deepEqual(a.calls[1]!.variables.input, { issueId: 'I_534', subIssueId: 'I_602', afterId: 'I_601' });
    assert.match(a.calls[1]!.query, /reprioritizeSubIssue/);
    const t = fake();
    await t.source.moveStep(k(534), k(602), null);
    assert.deepEqual(t.calls[1]!.variables.input, { issueId: 'I_534', subIssueId: 'I_602', beforeId: 'I_601' });
    const first = fake();
    await first.source.moveStep(k(534), k(601), null);
    assert.deepEqual(first.calls.map((c) => c.operation), ['WorkPlanSteps', 'WorkIssue']);
  });

  test('#534/AC-3 an after that is no sub-issue of the issue is WorkIssueRefusedError after; a step that is none is step', async () => {
    const { source } = fake();
    await assert.rejects(source.moveStep(k(534), k(602), k(999)), (e: any) => e instanceof WorkIssueRefusedError && e.param === 'after');
    await assert.rejects(source.moveStep(k(534), k(999), k(601)), (e: any) => e instanceof WorkIssueRefusedError && e.param === 'step');
  });
});

describe('#534/AC-4 removeStep', () => {
  test('#534/AC-4 one closeIssue with stateReason NOT_PLANNED', async () => {
    const { source, calls } = fake();
    await source.removeStep(k(534), k(602));
    assert.deepEqual(calls.map((c) => c.operation), ['WorkPlanSteps', 'CloseWorkPlanStep', 'WorkIssue']);
    assert.deepEqual(calls[1]!.variables.input, { issueId: 'I_602', stateReason: 'NOT_PLANNED' });
    assert.match(calls[1]!.query, /closeIssue/);
  });
});

describe('#534/AC-4 restoreStep', () => {
  const removed = (n: number) => node(n, { state: 'CLOSED', stateReason: 'NOT_PLANNED' });

  test('#534/AC-4 one reopenIssue with the step id as a variable, then the parent read back', async () => {
    const { source, calls } = fake({ subs: [node(601), removed(602)] });
    await source.restoreStep(k(534), k(602));
    assert.deepEqual(calls.map((c) => c.operation), ['WorkPlanSteps', 'ReopenWorkPlanStep', 'WorkIssue']);
    assert.deepEqual(calls[1]!.variables.input, { issueId: 'I_602' });
    assert.match(calls[1]!.query, /reopenIssue/);
  });

  test('#534/AC-4 a Plan sub-issue that is open or closed as completed is WorkIssueNotRemovedError, a non-Plan or absent one is WorkIssueRefusedError step; nothing is written', async () => {
    const { source, calls } = fake({ subs: [node(601), node(602, { state: 'CLOSED', stateReason: 'COMPLETED' }), { ...removed(603), issueType: { name: 'Tech Task' } }] });
    for (const step of [k(601), k(602)]) await assert.rejects(source.restoreStep(k(534), step), (e: any) => e instanceof WorkIssueNotRemovedError);
    for (const step of [k(603), k(999)]) await assert.rejects(source.restoreStep(k(534), step), (e: any) => e instanceof WorkIssueRefusedError && e.param === 'step');
    assert.ok(calls.every((c) => c.operation === 'WorkPlanSteps'));
  });

  test('#534/AC-5 a reopen that fails is never retried; a failed read-back is WorkIssueWrittenUnreadError; an unknown issue is null', async () => {
    const m = fake({ subs: [removed(602)], failOn: 'ReopenWorkPlanStep' });
    await assert.rejects(m.source.restoreStep(k(534), k(602)));
    assert.equal(m.calls.filter((c) => c.operation === 'ReopenWorkPlanStep').length, 1);
    const u = fake({ subs: [removed(602)], failOn: 'WorkIssue' });
    await assert.rejects(u.source.restoreStep(k(534), k(602)), (e: any) => e instanceof WorkIssueWrittenUnreadError);
    const f = (async () => new Response(JSON.stringify({ data: { repository: null } }), { status: 200 })) as unknown as typeof fetch;
    assert.equal(await new GithubGraphqlSource({ token: 't', fetch: f, sleep: async () => {} }).restoreStep(k(1), k(2)), null);
  });
});

describe('#534/AC-1 the read carries each step updatedAt', () => {
  test('#534/AC-1 the issue read maps updatedAt of each sub-issue from GitHub, and plan.steps carries it', async () => {
    const { source } = fake({ subs: [node(601, { updatedAt: '2026-11-11T09:00:00Z' }), node(602)] });
    const r = (await source.issue(k(534)))!;
    assert.deepEqual(r.subIssues.map((s) => [s.number, s.updatedAt]), [[601, '2026-11-11T09:00:00Z'], [602, '2026-11-10T10:00:00Z']]);
    assert.match(QUERIES.issue, /subIssues\(first: 50\) \{ nodes \{ .*issueType \{ name \} updatedAt \}/);
    assert.deepEqual(buildWorkIssue(r, null).plan.steps.map((s) => [s.number, s.updatedAt]), [[601, '2026-11-11T09:00:00Z'], [602, '2026-11-10T10:00:00Z']]);
  });

  test('#534/AC-1 a value cached before updatedAt was read gives an empty updatedAt, never undefined', () => {
    const ref = { key: k(1), repo: REPO, number: 1, title: 's', url: 'u', state: 'OPEN', type: 'Plan' } as WorkIssueRef;
    const read = { ...ref, number: 534, key: k(534), updatedAt: 't', labels: [], milestone: null, body: '', comments: [], commentsTotal: 0, parentChain: [], pullRequests: [], subIssues: [ref] } as WorkIssueRead;
    assert.equal(buildWorkIssue(read, null).plan.steps[0]!.updatedAt, '');
  });
});

describe('#534/AC-5 failures', () => {
  test('#534/AC-5 a mutation that fails is never retried; a failed read-back after the write is WorkIssueWrittenUnreadError', async () => {
    const m = fake({ failOn: 'CloseWorkPlanStep' });
    await assert.rejects(m.source.removeStep(k(534), k(602)));
    assert.equal(m.calls.filter((c) => c.operation === 'CloseWorkPlanStep').length, 1);
    const u = fake({ failOn: 'WorkIssue' });
    await assert.rejects(u.source.removeStep(k(534), k(602)), (e: any) => e instanceof WorkIssueWrittenUnreadError);
  });

  test('#534/AC-5 an unknown issue answers null from every step write, with nothing written', async () => {
    const calls: string[] = [];
    const f = (async (_u: string, init: RequestInit) => {
      calls.push(/(?:query|mutation) (\w+)/.exec(JSON.parse(String(init.body)).query)![1]);
      return new Response(JSON.stringify({ data: { repository: null } }), { status: 200 });
    }) as unknown as typeof fetch;
    const source = new GithubGraphqlSource({ token: 't', fetch: f, sleep: async () => {} });
    assert.deepEqual(await Promise.all([source.stepCurrent(k(1), k(2)), source.addStep(k(1), { title: 'x', body: '' }), source.removeStep(k(1), k(2)), source.moveStep(k(1), k(2), null)]), [null, null, null, null]);
    assert.ok(calls.every((c) => c === 'WorkPlanSteps'));
  });
});
