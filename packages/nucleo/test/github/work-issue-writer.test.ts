/*
 * #533 the GraphQL adapter of the issue write: it resolves what the edit names (labels, type, milestone,
 * parent) to GitHub's ids before it writes anything, writes with the connection's credential, never retries
 * a mutation, and answers with the issue as GitHub returns it. GitHub is a fake `fetch`.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { GithubGraphqlSource, GithubHttpError } from '../../src/github/github-source.ts';
import { WorkIssueForbiddenError, WorkIssueRefusedError } from '../../src/github/work-issue.ts';
import { k, REPO } from './helpers.ts';

const detail = (over: Record<string, unknown> = {}) => ({
  number: 533, title: 'written', url: `https://github.com/${REPO}/issues/533`, state: 'OPEN', updatedAt: '2026-11-12T12:00:00Z',
  repository: { nameWithOwner: REPO }, issueType: { name: 'Plan' }, body: 'written body', labels: { nodes: [{ name: 'backend' }] }, milestone: { title: 'Work board' },
  comments: { totalCount: 0, nodes: [] }, parent: null, subIssues: { nodes: [] }, closedByPullRequestsReferences: { nodes: [] }, ...over,
});

interface Call { operation: string; variables: any; headers: Record<string, string> }

function fake(over: { targets?: unknown; httpStatus?: Record<string, number> } = {}) {
  const calls: Call[] = [];
  const targets = over.targets ?? {
    repository: {
      id: 'R_1',
      issue: { id: 'I_533', viewerCanUpdate: true, parent: { id: 'I_OLD' } },
      labels: { nodes: [{ id: 'L_back', name: 'backend' }, { id: 'L_front', name: 'frontend' }] },
      issueTypes: { nodes: [{ id: 'T_plan', name: 'Plan' }, { id: 'T_task', name: 'Tech Task' }] },
      milestones: { nodes: [{ id: 'M_wb', title: 'Work board' }] },
    },
  };
  const f = (async (_u: string, init: RequestInit) => {
    const { query, variables } = JSON.parse(String(init.body));
    const operation = /(?:query|mutation) (\w+)/.exec(query)![1];
    calls.push({ operation, variables, headers: init.headers as Record<string, string> });
    const status = over.httpStatus?.[operation];
    if (status) return new Response(JSON.stringify({ message: 'raw github text' }), { status });
    const data: Record<string, unknown> =
      operation === 'WorkIssueCurrent' ? { repository: { issue: { title: 'on github', body: 'b', updatedAt: '2026-11-10T10:00:00Z' } } }
      : operation === 'WorkIssueTargets' ? targets as Record<string, unknown>
      : operation === 'WorkIssueId' ? { repository: { issue: variables.n === 999 ? null : { id: `I_${variables.n}` } } }
      : operation === 'WorkIssue' ? { repository: { issue: detail() } }
      : {};
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, source: new GithubGraphqlSource({ token: 'test-token', fetch: f, sleep: async () => {} }) };
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
    const { source, calls } = fake({ targets: { repository: { id: 'R', issue: null, labels: { nodes: [] }, issueTypes: { nodes: [] }, milestones: { nodes: [] } } } });
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
    const { source, calls } = fake({ targets: { repository: { id: 'R', issue: { id: 'I', viewerCanUpdate: false, parent: null }, labels: { nodes: [] }, issueTypes: { nodes: [] }, milestones: { nodes: [] } } } });
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
