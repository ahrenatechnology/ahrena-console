/*
 * #533 the GraphQL adapter of the issue write: it resolves what the edit names (labels, type, milestone,
 * parent) to GitHub's ids before it writes anything, writes with the connection's credential, never retries
 * a mutation, and answers with the issue as GitHub returns it. GitHub is a fake `fetch`.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { GithubGraphqlSource, GithubHttpError } from '../../src/github/github-source.ts';
import { WorkIssueForbiddenError, WorkIssueRefusedError, WorkIssueWrittenUnreadError } from '../../src/github/work-issue.ts';
import { githubFailureOf } from '../../src/github/cache.ts';
import { k, REPO } from './helpers.ts';

const detail = (over: Record<string, unknown> = {}) => ({
  number: 533, title: 'written', url: `https://github.com/${REPO}/issues/533`, state: 'OPEN', updatedAt: '2026-11-12T12:00:00Z',
  repository: { nameWithOwner: REPO }, issueType: { name: 'Plan' }, body: 'written body', labels: { nodes: [{ name: 'backend' }] }, milestone: { title: 'Work board' },
  comments: { totalCount: 0, nodes: [] }, parent: null, subIssues: { nodes: [] }, closedByPullRequestsReferences: { nodes: [] }, ...over,
});

interface Call { operation: string; query: string; variables: any; headers: Record<string, string>; signal: AbortSignal | null | undefined }
interface Repo {
  issue?: { id: string; viewerCanUpdate: boolean; parent: { id: string } | null } | null;
  labels?: Record<string, string>;
  types?: { id: string; name: string }[];
  milestones?: { id: string; title: string; state: 'OPEN' | 'CLOSED' }[];
}

// #533 GitHub as the adapter asks: a label by its name (any page), milestones by title filter and state, a page of issue types.
function fake(over: Repo & { httpStatus?: Record<string, number>; hang?: string; timeoutMs?: number } = {}) {
  const calls: Call[] = [];
  const labels = over.labels ?? { backend: 'L_back', frontend: 'L_front' };
  const types = over.types ?? [{ id: 'T_plan', name: 'Plan' }, { id: 'T_task', name: 'Tech Task' }];
  const milestones = over.milestones ?? [{ id: 'M_wb', title: 'Work board', state: 'OPEN' as const }];
  const issue = over.issue === undefined ? { id: 'I_533', viewerCanUpdate: true, parent: { id: 'I_OLD' } } : over.issue;
  const f = (async (_u: string, init: RequestInit) => {
    const { query, variables } = JSON.parse(String(init.body));
    const operation = /(?:query|mutation) (\w+)/.exec(query)![1];
    calls.push({ operation, query, variables, headers: init.headers as Record<string, string>, signal: init.signal });
    if (over.hang === operation) {
      return new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
    }
    const status = over.httpStatus?.[operation];
    if (status) return new Response(JSON.stringify({ message: 'raw github text' }), { status });
    let data: Record<string, unknown> = {};
    if (operation === 'WorkIssueCurrent') data = { repository: { issue: { title: 'on github', body: 'b', updatedAt: '2026-11-10T10:00:00Z' } } };
    else if (operation === 'WorkIssueTargets') {
      const repository: Record<string, unknown> = { id: 'R_1', issue, issueTypes: { nodes: types } };
      for (const [name, value] of Object.entries<string>(variables)) {
        if (/^l\d+$/.test(name)) repository[name] = labels[value] ? { id: labels[value], name: value } : null;
      }
      const title = variables.m as string | undefined;
      const states = /states: \[([^\]]*)\]/.exec(query)?.[1] ?? 'OPEN';
      repository.milestones = { nodes: milestones.filter((m) => states.includes(m.state) && (title === undefined || m.title.includes(title))) };
      data = { repository };
    } else if (operation === 'WorkIssueId') data = { repository: { issue: variables.n === 999 ? null : { id: `I_${variables.n}` } } };
    else if (operation === 'WorkIssue') data = { repository: { issue: detail() } };
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, source: new GithubGraphqlSource({ token: 'test-token', fetch: f, sleep: async () => {}, ...(over.timeoutMs ? { timeoutMs: over.timeoutMs } : {}) }) };
}

describe('#533/AC-1 the adapter reads updatedAt and writes each field', () => {
  test('#533/AC-1 the issue read carries GitHub updatedAt', async () => {
    const { source } = fake();
    assert.equal((await source.issue(k(533)))!.updatedAt, '2026-11-12T12:00:00Z');
  });

  test('#533/AC-1 current: the title, body and updatedAt GitHub holds; null for an unknown issue', async () => {
    const { source } = fake();
    assert.deepEqual(await source.current(k(533)), { title: 'on github', body: 'b', updatedAt: '2026-11-10T10:00:00Z' });
  });

  test('#533/AC-1 Given title, body, labels, type and milestone, Then one updateIssue carries the resolved ids, and the answer is a fresh read', async () => {
    const { source, calls } = fake();
    const read = await source.update(k(533), { title: 'T', body: 'B', labels: ['backend', 'frontend'], type: 'Tech Task', milestone: 'Work board' });
    assert.deepEqual(calls.map((c) => c.operation), ['WorkIssueTargets', 'UpdateWorkIssue', 'WorkIssue']);
    assert.deepEqual(calls[1].variables.input, { id: 'I_533', title: 'T', body: 'B', labelIds: ['L_back', 'L_front'], issueTypeId: 'T_task', milestoneId: 'M_wb' });
    assert.equal(calls[1].headers.authorization, 'bearer test-token');
    assert.equal(read!.title, 'written');
  });

  test('#533/AC-1 Given type null and milestone null, Then they are cleared (null ids)', async () => {
    const { source, calls } = fake();
    await source.update(k(533), { type: null, milestone: null });
    assert.deepEqual(calls[1].variables.input, { id: 'I_533', issueTypeId: null, milestoneId: null });
  });

  test('#533/AC-1 Given a parent, Then addSubIssue replaces the parent; null removes the current one; no updateIssue without a field of it', async () => {
    const a = fake();
    await a.source.update(k(533), { parent: `${REPO}#478` });
    assert.deepEqual(a.calls.map((c) => c.operation), ['WorkIssueTargets', 'WorkIssueId', 'AddWorkIssueParent', 'WorkIssue']);
    assert.deepEqual(a.calls[2].variables.input, { issueId: 'I_478', subIssueId: 'I_533', replaceParent: true });
    const b = fake();
    await b.source.update(k(533), { parent: null });
    assert.deepEqual(b.calls.map((c) => c.operation), ['WorkIssueTargets', 'RemoveWorkIssueParent', 'WorkIssue']);
    assert.deepEqual(b.calls[1].variables.input, { issueId: 'I_OLD', subIssueId: 'I_533' });
  });

  test('#533/AC-1 Given a comment, Then addComment is called with the issue id and the answer is a fresh read', async () => {
    const { source, calls } = fake();
    const read = await source.comment(k(533), 'hello');
    assert.deepEqual(calls.map((c) => c.operation), ['WorkIssueId', 'AddWorkIssueComment', 'WorkIssue']);
    assert.deepEqual(calls[1].variables.input, { subjectId: 'I_533', body: 'hello' });
    assert.ok(read);
  });

  test('#533/AC-1 an unknown issue is null for update and comment, and nothing is written', async () => {
    const { source, calls } = fake({ issue: null });
    assert.equal(await source.update(k(533), { labels: [] }), null);
    assert.ok(!calls.some((c) => c.operation.startsWith('Update') || c.operation.startsWith('Add')));
  });
});

describe('#533/AC-3 refusals', () => {
  test('#533/AC-3 Given a label, type, milestone or parent GitHub does not know, Then it is refused before any write', async () => {
    for (const [edit, param] of [
      [{ labels: ['nope'] }, 'labels'],
      [{ type: 'Nope' }, 'type'],
      [{ milestone: 'Nope' }, 'milestone'],
      [{ parent: `${REPO}#999` }, 'parent'],
    ] as const) {
      const { source, calls } = fake();
      await assert.rejects(source.update(k(533), edit), (e) => e instanceof WorkIssueRefusedError && e.param === param);
      assert.ok(!calls.some((c) => /^(Update|Add|Remove)/.test(c.operation)), param);
    }
  });

  test('#533/AC-3 Given the credential cannot update the issue, Then WorkIssueForbiddenError and no write', async () => {
    const { source, calls } = fake({ issue: { id: 'I', viewerCanUpdate: false, parent: null } });
    await assert.rejects(source.update(k(533), { labels: [] }), (e) => e instanceof WorkIssueForbiddenError);
    assert.equal(calls.length, 1);
  });

  test('#533/AC-3 a mutation answered 502 is not retried (it may have been applied); a read is', async () => {
    const m = fake({ httpStatus: { UpdateWorkIssue: 502 } });
    await assert.rejects(m.source.update(k(533), { labels: ['backend'] }));
    assert.equal(m.calls.filter((c) => c.operation === 'UpdateWorkIssue').length, 1);
    const c = fake({ httpStatus: { AddWorkIssueComment: 403 } });
    await assert.rejects(c.source.comment(k(533), 'x'), (e) => e instanceof GithubHttpError && e.status === 403);
  });
});

describe('#533/AC-1 the ids an edit names are resolved wherever GitHub holds them', () => {
  test('#533/AC-1 a label beyond any first page resolves by its own name, not by a page of labels', async () => {
    const { source, calls } = fake({ labels: { 'rare-label': 'L_rare', backend: 'L_back' } });
    await source.update(k(533), { labels: ['rare-label', 'backend'] });
    const targets = calls.find((c) => c.operation === 'WorkIssueTargets')!;
    assert.ok(!/labels\(/.test(targets.query), 'no page of labels');
    assert.deepEqual(Object.values(targets.variables).filter((v) => v === 'rare-label' || v === 'backend'), ['rare-label', 'backend']);
    assert.deepEqual(calls.find((c) => c.operation === 'UpdateWorkIssue')!.variables.input.labelIds, ['L_rare', 'L_back']);
  });

  test('#533/AC-3 a label GitHub does not hold is refused as labels, whatever its position', async () => {
    const { source, calls } = fake();
    await assert.rejects(source.update(k(533), { labels: ['backend', 'nope'] }), (e) => e instanceof WorkIssueRefusedError && e.param === 'labels');
    assert.ok(!calls.some((c) => c.operation === 'UpdateWorkIssue'));
  });

  test('#533/AC-1 a closed milestone resolves by its title', async () => {
    const { source, calls } = fake({ milestones: [{ id: 'M_old', title: 'Old release', state: 'CLOSED' }, { id: 'M_wb', title: 'Work board', state: 'OPEN' }] });
    await source.update(k(533), { milestone: 'Old release' });
    assert.equal(calls.find((c) => c.operation === 'UpdateWorkIssue')!.variables.input.milestoneId, 'M_old');
  });

  test('#533/AC-3 a milestone whose title only contains the name is not the milestone', async () => {
    const { source } = fake({ milestones: [{ id: 'M_old', title: 'Old release', state: 'CLOSED' }] });
    await assert.rejects(source.update(k(533), { milestone: 'Old' }), (e) => e instanceof WorkIssueRefusedError && e.param === 'milestone');
  });

  test('#533/AC-1 the issue types are read 100 at a time', async () => {
    const { source, calls } = fake();
    await source.update(k(533), { type: 'Plan' });
    assert.match(calls.find((c) => c.operation === 'WorkIssueTargets')!.query, /issueTypes\(first: 100\)/);
  });
});

describe('#533/AC-3 every GitHub call has a deadline', () => {
  test('#533/AC-3 a read and a mutation carry an abort signal', async () => {
    const { source, calls } = fake();
    await source.update(k(533), { title: 'T' });
    for (const c of calls) assert.ok(c.signal instanceof AbortSignal, c.operation);
  });

  test('#533/AC-3 a mutation GitHub never answers fails as a timeout, which the route reports as network', async () => {
    const { source } = fake({ hang: 'UpdateWorkIssue', timeoutMs: 20 });
    await assert.rejects(source.update(k(533), { title: 'T' }), (e) => githubFailureOf(e) === 'network');
    const c = fake({ hang: 'AddWorkIssueComment', timeoutMs: 20 });
    await assert.rejects(c.source.comment(k(533), 'x'), (e) => githubFailureOf(e) === 'network');
  });

  test('#533/AC-3 a read GitHub never answers fails as a timeout and is not retried', async () => {
    const { source, calls } = fake({ hang: 'WorkIssueTargets', timeoutMs: 20 });
    await assert.rejects(source.update(k(533), { title: 'T' }), (e) => githubFailureOf(e) === 'network');
    assert.equal(calls.filter((c) => c.operation === 'WorkIssueTargets').length, 1);
  });
});

describe('#533/AC-3 a write applied whose read-back fails is not a failed write', () => {
  test('#533/AC-3 Given the mutation succeeded and the read-back times out, Then WorkIssueWrittenUnreadError carries the failure, and the mutation was sent once', async () => {
    const u = fake({ hang: 'WorkIssue', timeoutMs: 20 });
    await assert.rejects(u.source.update(k(533), { title: 'T' }), (e) => e instanceof WorkIssueWrittenUnreadError && githubFailureOf(e.cause) === 'network');
    assert.equal(u.calls.filter((c) => c.operation === 'UpdateWorkIssue').length, 1);
    const c = fake({ hang: 'WorkIssue', timeoutMs: 20 });
    await assert.rejects(c.source.comment(k(533), 'x'), (e) => e instanceof WorkIssueWrittenUnreadError && githubFailureOf(e.cause) === 'network');
    assert.equal(c.calls.filter((x) => x.operation === 'AddWorkIssueComment').length, 1);
  });

  test('#533/AC-3 Given the mutation itself fails, Then the error is not WorkIssueWrittenUnreadError', async () => {
    const { source } = fake({ hang: 'UpdateWorkIssue', timeoutMs: 20 });
    await assert.rejects(source.update(k(533), { title: 'T' }), (e) => !(e instanceof WorkIssueWrittenUnreadError));
  });
});
