/*
 * #506 the issue detail the work board's panel reads (wireframe 467-1): the pure view built from one
 * GitHub read, with no IO. Each scenario names the acceptance criterion it covers.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildWorkIssue, type WorkIssueRead, type WorkIssueRef } from '../../src/github/work-issue.ts';
import { k, REPO } from './helpers.ts';

const ref = (n: number, over: Partial<WorkIssueRef> = {}): WorkIssueRef => ({
  key: k(n),
  repo: REPO,
  number: n,
  title: `issue ${n}`,
  url: `https://github.com/${REPO}/issues/${n}`,
  state: 'OPEN',
  type: 'Plan',
  ...over,
});

const read = (over: Partial<WorkIssueRead> = {}): WorkIssueRead => ({
  ...ref(506),
  labels: ['backend'],
  milestone: 'Work board',
  body: 'the body',
  comments: [
    { author: 'ana', createdAt: '2026-11-10T10:00:00Z', body: 'first' },
    { author: null, createdAt: '2026-11-11T10:00:00Z', body: 'second' },
  ],
  commentsTotal: 2,
  parentChain: [ref(467, { type: 'Epic' }), ref(464, { type: 'Initiative' })],
  subIssues: [],
  pullRequests: [],
  ...over,
});

describe('#506/AC-1 the issue detail view', () => {
  test('#506/AC-1 Given an issue with body, comments and a parent chain, When the view is built, Then it has the header, the body, the comments and the parents root-first', () => {
    const v = buildWorkIssue(read(), 'In Progress');
    assert.deepEqual(
      [v.type, v.number, v.title, v.state, v.url, v.repo, v.labels, v.milestone, v.projectStatus],
      ['Plan', 506, 'issue 506', 'OPEN', `https://github.com/${REPO}/issues/506`, REPO, ['backend'], 'Work board', 'In Progress'],
    );
    assert.equal(v.body, 'the body');
    assert.deepEqual(v.comments.map((c) => [c.author, c.createdAt, c.body]), [
      ['ana', '2026-11-10T10:00:00Z', 'first'],
      [null, '2026-11-11T10:00:00Z', 'second'],
    ]);
    assert.deepEqual(v.parents.map((p) => p.number), [464, 467], 'the root first');
  });

  test('#506/AC-1 Given an issue outside the Project, Then projectStatus is null', () => {
    assert.equal(buildWorkIssue(read(), null).projectStatus, null);
  });

  test('#506/AC-1 Given sub-issues of any type, Then subIssues keeps them all with their state in GitHub order', () => {
    const v = buildWorkIssue(read({ subIssues: [ref(521, { state: 'CLOSED' }), ref(530, { type: 'Task' }), ref(520)] }), null);
    assert.deepEqual(v.subIssues.map((s) => [s.number, s.state, s.type]), [[521, 'CLOSED', 'Plan'], [530, 'OPEN', 'Task'], [520, 'OPEN', 'Plan']]);
  });

  test('#506/AC-1 Given an open PR with 3 of 5 checks done and a review required, Then pullRequest carries CI, English check counts and review', () => {
    const v = buildWorkIssue(
      read({
        pullRequests: [{ number: 900, title: 'the pr', url: 'u', state: 'OPEN', isDraft: false, review: 'REVIEW_REQUIRED', ci: 'PENDING', checks: { total: 5, ok: 3, falhas: 0, rodando: 2 } }],
      }),
      null,
    );
    assert.deepEqual(v.pullRequest, {
      number: 900,
      title: 'the pr',
      url: 'u',
      state: 'OPEN',
      isDraft: false,
      ci: 'PENDING',
      checks: { total: 5, passed: 3, failed: 0, running: 2 },
      review: 'REVIEW_REQUIRED',
    });
  });

  test('#506/AC-1 Given a closed PR and an open one, Then the open one is the linked pull request; with none, null', () => {
    const p = (number: number, state: 'OPEN' | 'CLOSED' | 'MERGED') => ({ number, title: `pr ${number}`, url: 'u', state, isDraft: false, review: null, ci: null, checks: null });
    assert.equal(buildWorkIssue(read({ pullRequests: [p(1, 'CLOSED'), p(2, 'OPEN')] }), null).pullRequest?.number, 2);
    assert.equal(buildWorkIssue(read({ pullRequests: [p(1, 'CLOSED'), p(3, 'MERGED')] }), null).pullRequest?.number, 3, 'merged over closed');
    assert.equal(buildWorkIssue(read(), null).pullRequest, null);
    assert.equal(buildWorkIssue(read({ pullRequests: [p(1, 'OPEN')] }), null).pullRequest?.checks, null);
  });
});

describe('#506/AC-2 the plan steps', () => {
  test('#506/AC-2 Given five Plan sub-issues (one closed) and a Task, Then plan.steps are the Plan ones in order with their count', () => {
    const subs = [ref(520), ref(521, { state: 'CLOSED' }), ref(525, { type: 'Task' }), ref(522), ref(523), ref(524)];
    const v = buildWorkIssue(read({ subIssues: subs }), null);
    assert.equal(v.plan.count, 5);
    assert.deepEqual(v.plan.steps.map((s) => [s.number, s.title, s.state]), [
      [520, 'issue 520', 'OPEN'],
      [521, 'issue 521', 'CLOSED'],
      [522, 'issue 522', 'OPEN'],
      [523, 'issue 523', 'OPEN'],
      [524, 'issue 524', 'OPEN'],
    ]);
    assert.equal(v.subIssues.length, 6, 'the other sub-issues stay in subIssues');
  });

  test('#506/AC-2 Given no Plan sub-issue, Then the plan is empty with count 0', () => {
    assert.deepEqual(buildWorkIssue(read({ subIssues: [ref(525, { type: 'Task' })] }), null).plan, { count: 0, steps: [] });
  });
});
