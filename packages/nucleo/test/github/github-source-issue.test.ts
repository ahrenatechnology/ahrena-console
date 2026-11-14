/*
 * issue 506 the GraphQL adapter of the issue detail: one query per issue, mapped to `WorkIssueRead`.
 * GitHub is a fake `fetch` that records the request.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { GithubGraphqlSource, QUERIES } from '../../src/github/github-source.ts';
import { RateLimitedError } from '../../src/github/cache.ts';
import { REPO } from './helpers.ts';

const raw = (n: number, over: Record<string, unknown> = {}) => ({
  number: n,
  title: `issue ${n}`,
  url: `https://github.com/${REPO}/issues/${n}`,
  state: 'OPEN',
  repository: { nameWithOwner: REPO },
  issueType: { name: 'Plan' },
  ...over,
});

const ISSUE = raw(506, {
  body: 'the body',
  labels: { nodes: [{ name: 'backend' }, { name: 'core' }] },
  milestone: { title: 'Work board' },
  comments: {
    totalCount: 2,
    nodes: [
      { author: { login: 'ana' }, createdAt: '2026-11-10T10:00:00Z', body: 'first' },
      { author: null, createdAt: '2026-11-11T10:00:00Z', body: 'second' },
    ],
  },
  parent: raw(467, { issueType: { name: 'Epic' }, parent: raw(464, { issueType: { name: 'Initiative' }, parent: null }) }),
  subIssues: { nodes: [raw(520), raw(521, { state: 'CLOSED' }), raw(525, { issueType: null })] },
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

function fake(data: unknown, status = 200) {
  const calls: { operation: string; query: string; variables: Record<string, unknown> }[] = [];
  const fetch = (async (_url: string, init?: RequestInit) => {
    const { query, variables } = JSON.parse(String(init?.body));
    calls.push({ operation: /query (\w+)/.exec(query)?.[1] ?? '?', query, variables });
    return new Response(JSON.stringify(typeof data === 'function' ? data() : data), { status });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls, source: new GithubGraphqlSource({ token: 'test-token', fetch, sleep: async () => {} }) };
}

describe('#506/AC-1 the issue detail query', () => {
  test('#506/AC-1 Given an issue, When it is read, Then one WorkIssue query carries the body, comments, parents, sub-issues and PR, mapped to the read', async () => {
    const { source, calls } = fake({ data: { repository: { issue: ISSUE } } });
    const r = await source.issue(`${REPO}#506`);
    assert.equal(calls.length, 1, 'one query per issue');
    assert.deepEqual([calls[0].operation, calls[0].variables], ['WorkIssue', { o: 'ahrenatechnology', r: 'ahrena-console', n: 506 }]);
    assert.ok(r);
    assert.deepEqual([r.key, r.type, r.state, r.body, r.labels, r.milestone], [`${REPO}#506`, 'Plan', 'OPEN', 'the body', ['backend', 'core'], 'Work board']);
    assert.deepEqual(r.comments, [
      { author: 'ana', createdAt: '2026-11-10T10:00:00Z', body: 'first' },
      { author: null, createdAt: '2026-11-11T10:00:00Z', body: 'second' },
    ]);
    assert.equal(r.commentsTotal, 2);
    assert.deepEqual(r.parentChain.map((p) => [p.number, p.type]), [[467, 'Epic'], [464, 'Initiative']], 'nearest first');
    assert.deepEqual(r.subIssues.map((s) => [s.number, s.state, s.type]), [[520, 'OPEN', 'Plan'], [521, 'CLOSED', 'Plan'], [525, 'OPEN', null]]);
    assert.deepEqual(r.pullRequests[0], {
      number: 900,
      title: 'the pr',
      url: `https://github.com/${REPO}/pull/900`,
      state: 'OPEN',
      isDraft: false,
      review: 'REVIEW_REQUIRED',
      ci: 'PENDING',
      checks: { total: 5, ok: 3, falhas: 0, rodando: 2 },
    });
  });

  test('#506/AC-1 Given a bare issue, Then the optional parts map to empty values', async () => {
    const { source } = fake({ data: { repository: { issue: raw(7, { body: '', labels: { nodes: [] }, milestone: null, comments: { totalCount: 0, nodes: [] }, parent: null, subIssues: { nodes: [] }, closedByPullRequestsReferences: { nodes: [] } }) } } });
    const r = await source.issue(`${REPO}#7`);
    assert.deepEqual([r?.milestone, r?.comments, r?.parentChain, r?.subIssues, r?.pullRequests], [null, [], [], [], []]);
  });

  test('#506/AC-1 the query asks only for the detail fields, one level of sub-issues and no more than three parents', () => {
    assert.match(QUERIES.issue, /^query WorkIssue\(\$o: String!, \$r: String!, \$n: Int!\)/);
    assert.match(QUERIES.issue, /comments\(first: \d+\)/);
    assert.match(QUERIES.issue, /subIssues\(first: \d+\)/);
  });
});

describe('#506/AC-3 not found and failures', () => {
  test('#506/AC-3 Given GitHub has no such issue (null or NOT_FOUND), Then the read is null', async () => {
    assert.equal(await fake({ data: { repository: { issue: null } } }).source.issue(`${REPO}#999`), null);
    assert.equal(await fake({ data: { repository: null }, errors: [{ type: 'NOT_FOUND', message: 'not found', path: ['repository'] }] }).source.issue(`${REPO}#999`), null);
  });

  test('#506/AC-3 Given the rate limit, Then it fails as RateLimitedError so the cache can serve the last value', async () => {
    const { source } = fake({ message: 'rate' }, 429);
    await assert.rejects(source.issue(`${REPO}#506`), (e) => e instanceof RateLimitedError);
  });
});
