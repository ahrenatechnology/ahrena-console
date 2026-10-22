// The Dev Console domain (#177, decision 0008 section 4): the merge queue, the board columns and the
// scoreboard, derived from synthetic facts. No GitHub, no database, no network.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildBoard, buildMergeQueue, buildScoreboard, columnOf, DEFAULT_BLOCKED_LABELS, mergedSince, ownReasons } from '../../src/dev-console/model.ts';
import { contextSession, hoursAgo, issue, merged, NOW, OTHER_REPO, pr, REPO } from './helpers.ts';

const numbers = (xs: readonly { number: number }[]) => xs.map((x) => x.number);

describe('merge queue', () => {
  test('#177/AC-2 ready is CI green, no conflict, not draft and no changes requested; oldest first', () => {
    const q = buildMergeQueue([pr(3, { createdAt: hoursAgo(1) }), pr(1, { createdAt: hoursAgo(30) }), pr(2, { createdAt: hoursAgo(5), review: null })]);
    assert.deepEqual(numbers(q.ready), [1, 2, 3]);
    assert.deepEqual(q.notReady, []);
  });

  test('#177/AC-2 not-ready PRs carry their reason: draft, conflict, behind, ci-running, ci-failing, no-ci, changes-requested', () => {
    const q = buildMergeQueue([
      pr(10, { isDraft: true }),
      pr(11, { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }),
      pr(12, { mergeStateStatus: 'BEHIND' }),
      pr(13, { ci: 'PENDING' }),
      pr(14, { ci: 'FAILURE' }),
      pr(15, { ci: null }),
      pr(16, { review: 'CHANGES_REQUESTED' }),
    ]);
    assert.deepEqual(q.ready, []);
    assert.deepEqual(
      q.notReady.map((n) => [n.number, n.reason]),
      [
        [10, 'draft'],
        [11, 'conflict'],
        [12, 'behind'],
        [13, 'ci-running'],
        [14, 'ci-failing'],
        [15, 'no-ci'],
        [16, 'changes-requested'],
      ],
    );
  });

  test('#177/AC-2 the reason is the highest-priority one, and `reasons` lists them all', () => {
    const [n] = buildMergeQueue([pr(20, { isDraft: true, ci: 'FAILURE', mergeable: 'CONFLICTING' })]).notReady;
    assert.equal(n.reason, 'draft');
    assert.deepEqual(n.reasons, ['draft', 'conflict', 'ci-failing']);
    assert.deepEqual(ownReasons(pr(21, { ci: 'EXPECTED' })), ['ci-running']);
  });

  test('#177/AC-6 a stacked PR comes right after its base, even when it is older than the base', () => {
    const base = pr(79, { headRefName: 'feat/58-esquema', createdAt: hoursAgo(5) });
    const stacked = pr(84, { baseRefName: 'feat/58-esquema', headRefName: 'feat/60-indices', createdAt: hoursAgo(20) });
    const older = pr(81, { createdAt: hoursAgo(8) });
    const q = buildMergeQueue([stacked, base, older]);
    assert.deepEqual(numbers(q.ready), [81, 79, 84]);
    assert.equal(q.ready[2].stackedOn, 79);
    assert.equal(q.ready[1].stackedOn, null);
  });

  test('#177/AC-6 a PR stacked on a base that is not ready stays out with `stacked`; the whole stack is walked', () => {
    const base = pr(79, { headRefName: 'feat/58-esquema', ci: 'PENDING' });
    const middle = pr(84, { baseRefName: 'feat/58-esquema', headRefName: 'feat/60-indices' });
    const top = pr(85, { baseRefName: 'feat/60-indices', headRefName: 'feat/61-cache' });
    const q = buildMergeQueue([base, middle, top]);
    assert.deepEqual(q.ready, []);
    assert.deepEqual(
      q.notReady.map((n) => [n.number, n.reason, n.stackedOn]),
      [
        [79, 'ci-running', null],
        [84, 'stacked', 79],
        [85, 'stacked', 84],
      ],
    );
  });

  test('#177/AC-6 a fork PR with headRefName main does not stack the PRs that target main', () => {
    const fork = pr(90, { headRefName: 'main', isCrossRepository: true, ci: 'FAILURE', createdAt: hoursAgo(40) });
    const a = pr(91, { createdAt: hoursAgo(20) });
    const b = pr(92, { createdAt: hoursAgo(10) });
    const q = buildMergeQueue([fork, a, b]);
    assert.deepEqual(numbers(q.ready), [91, 92]);
    assert.deepEqual(q.ready.map((x) => x.stackedOn), [null, null]);
    assert.deepEqual(q.notReady.map((n) => [n.number, n.reasons]), [[90, ['ci-failing']]]);
  });

  test('#177/AC-2 mergeable UNKNOWN is not ready: notReady with checking, right after conflict', () => {
    const q = buildMergeQueue([pr(93, { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })]);
    assert.deepEqual(q.ready, []);
    assert.deepEqual(q.notReady.map((n) => [n.number, n.reason, n.reasons]), [[93, 'checking', ['checking']]]);
    assert.deepEqual(ownReasons(pr(94, { mergeable: 'UNKNOWN', ci: 'FAILURE' })), ['checking', 'ci-failing']);
    assert.deepEqual(ownReasons(pr(95, { isDraft: true, mergeable: 'UNKNOWN' })), ['draft', 'checking']);
  });

  test('#177/AC-6 stacking only applies within the same repository', () => {
    const a = pr(1, { headRefName: 'feat/1-x', ci: 'FAILURE' });
    const b = pr(2, { repo: OTHER_REPO, baseRefName: 'feat/1-x' });
    const q = buildMergeQueue([a, b]);
    assert.deepEqual(numbers(q.ready), [2]);
    assert.equal(q.ready[0].stackedOn, null);
  });
});

describe('board columns', () => {
  const none = { pullRequest: null, remoteBranch: false, session: null };

  test('#177/AC-3 todo: open, no branch, no PR and no session', () => {
    assert.equal(columnOf(issue(64), none), 'todo');
  });
  test('#177/AC-3 delegated: open session on a branch with the number, not pushed yet', () => {
    assert.equal(columnOf(issue(68), { ...none, session: contextSession('s', { branch: 'feat/68-cupom' }) }), 'delegated');
  });
  test('#177/AC-3 in-progress: branch with the number on the remote', () => {
    assert.equal(columnOf(issue(61), { ...none, remoteBranch: true, session: contextSession('s') }), 'in-progress');
  });
  test('#177/AC-3 in-review: open PR that closes the issue', () => {
    assert.equal(columnOf(issue(31), { ...none, remoteBranch: true, pullRequest: pr(81, { closes: [31] }) }), 'in-review');
  });
  test('#177/AC-3 blocked: the label beats everything; the default is blocked or bloqueada, and the label is configurable', () => {
    assert.deepEqual(DEFAULT_BLOCKED_LABELS, ['blocked', 'bloqueada']);
    assert.equal(columnOf(issue(55, { labels: ['Blocked'] }), { ...none, pullRequest: pr(1) }), 'blocked');
    assert.equal(columnOf(issue(55, { labels: ['bloqueada'] }), none), 'blocked');
    assert.equal(columnOf(issue(55, { labels: ['espera-fornecedor'] }), none), 'todo');
    assert.equal(columnOf(issue(55, { labels: ['espera-fornecedor'] }), none, ['espera-fornecedor']), 'blocked');
    assert.equal(columnOf(issue(55, { labels: ['blocked'] }), none, ['espera-fornecedor']), 'todo');
  });

  test('#177/AC-3 the board: each issue in its column, with session, PR and CI; done only those closed in 24 h', () => {
    const board = buildBoard({
      openIssues: [issue(64), issue(68), issue(61), issue(72), issue(31), issue(55, { labels: ['blocked'] })],
      closedIssues: [issue(52, { state: 'CLOSED', closedAt: hoursAgo(2) }), issue(50, { state: 'CLOSED', closedAt: hoursAgo(1) }), issue(40, { state: 'CLOSED', closedAt: hoursAgo(30) })],
      openPullRequests: [pr(81, { closes: [31], headRefName: 'feat/31-csv', ci: 'FAILURE' })],
      remoteBranches: new Map([[REPO, ['main', 'feat/61-cobranca', 'fix/issue-72', 'feat/31-csv']]]),
      sessions: [
        contextSession('s68', { branch: 'feat/68-cupom', waitingOnYou: true, working: false, attention: { level: 'blocked', reason: 'permission' } }),
        contextSession('s61', { branch: 'feat/61-cobranca' }),
        contextSession('outro-repo', { repo: OTHER_REPO, branch: 'feat/64-x' }),
      ],
      now: NOW,
    });
    assert.deepEqual(numbers(board.todo), [64]);
    assert.deepEqual(numbers(board.delegated), [68]);
    assert.deepEqual(numbers(board['in-progress']), [61, 72]);
    assert.deepEqual(numbers(board['in-review']), [31]);
    assert.deepEqual(numbers(board.blocked), [55]);
    assert.deepEqual(numbers(board.done), [50, 52]);
    assert.deepEqual(board.delegated[0].session, { id: 's68', title: 'sessão s68', waitingOnYou: true, attention: { level: 'blocked', reason: 'permission' } });
    assert.equal(board['in-progress'][0].session?.id, 's61');
    assert.deepEqual(board['in-review'][0].pullRequest, { number: 81, url: `https://github.com/${REPO}/pull/81`, isDraft: false });
    assert.equal(board['in-review'][0].ci, 'failing');
    assert.equal(board.todo[0].session, null);
  });

  test('#177/AC-3 a session on a branch already on the remote does not leave the issue in delegated', () => {
    const board = buildBoard({
      openIssues: [issue(68)],
      closedIssues: [],
      openPullRequests: [],
      remoteBranches: new Map([[REPO, ['feat/68-cupom']]]),
      sessions: [contextSession('s68', { branch: 'feat/68-cupom' })],
      now: NOW,
    });
    assert.deepEqual(numbers(board['in-progress']), [68]);
    assert.deepEqual(board.delegated, []);
  });
});

describe('scoreboard and merged', () => {
  test('#177/AC-2 the scoreboard counts ready, CI running, CI failing or conflict, working and waiting on you', () => {
    const prs = [pr(1), pr(2, { ci: 'PENDING' }), pr(3, { ci: 'FAILURE' }), pr(4, { mergeable: 'CONFLICTING' }), pr(5, { isDraft: true, ci: 'FAILURE' })];
    const s = buildScoreboard({
      queue: buildMergeQueue(prs),
      openPullRequests: prs,
      sessions: [contextSession('a'), contextSession('b', { working: false, waitingOnYou: true }), contextSession('c', { working: false, attention: { level: 'idle', reason: 'turn_ended' } })],
      dependsOnYou: 2,
    });
    assert.deepEqual(s, { ready: 1, ciRunning: 1, ciFailingOrConflict: 2, sessionsWorking: 1, waitingOnYou: 2, idle: 1 });
  });

  test('#177/AC-2 merged in the last 24 h, most recent first', () => {
    const list = mergedSince([merged(76, hoursAgo(18)), merged(80, hoursAgo(3)), merged(70, hoursAgo(25))], NOW);
    assert.deepEqual(numbers(list), [80, 76]);
  });
});
