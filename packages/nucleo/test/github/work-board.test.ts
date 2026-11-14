import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildWorkBoard,
  columnOfIssue,
  columnOfParent,
  DONE_WINDOW_DAYS,
  EMPTY_WORK_QUEUE,
  issueOfPrompt,
  parseWorkBoardFilters,
  REVIEW_ROUNDS_LIMIT,
  statusIndex,
  statusSlug,
  typeSlugOf,
  WORK_BLOCKED_REASONS,
  WORK_BOARD_COLUMNS,
  WORK_LEVELS,
  type LinkedPullRequest,
  type WorkSessionLink,
  type WorkBoardCard,
  type WorkBoardFilters,
  type WorkBoardInput,
  type WorkBoardNode,
  type WorkBoardView,
} from '../../src/index.ts';
import { k, REPO } from './helpers.ts';

const NOW = Date.parse('2026-11-13T12:00:00Z');
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const daysAgo = (d: number) => iso(NOW - d * DAY);

const STATUSES = [
  { id: 'opt-todo', name: 'Todo' },
  { id: 'opt-progress', name: 'In Progress' },
  { id: 'opt-done', name: 'Done' },
];

function boardNode(n: number, over: Partial<WorkBoardNode> = {}): WorkBoardNode {
  return {
    key: k(n),
    repo: REPO,
    number: n,
    title: `issue ${n}`,
    url: `https://github.com/${REPO}/issues/${n}`,
    state: 'OPEN',
    type: 'Task',
    parent: null,
    labels: [],
    milestone: null,
    closedAt: null,
    statusId: null,
    subIssues: null,
    pullRequest: null,
    inProject: true,
    ...over,
  };
}

function pr(over: Partial<LinkedPullRequest> = {}): LinkedPullRequest {
  return { number: 900, url: `https://github.com/${REPO}/pull/900`, state: 'OPEN', isDraft: false, review: null, ci: null, ...over };
}

const session = (id: string, n: number, state: WorkSessionLink['state']): WorkSessionLink => ({ sessionId: id, key: k(n), state, since: daysAgo(0) });

const filters = (over: Partial<WorkBoardFilters> = {}): WorkBoardFilters => ({
  level: 'item',
  initiative: null,
  epic: null,
  type: null,
  label: null,
  repo: null,
  status: null,
  ...over,
});

function board(nodes: WorkBoardNode[], over: Partial<WorkBoardInput> = {}): WorkBoardView {
  return buildWorkBoard({
    project: { owner: 'ahrenatechnology', number: 3, title: 'Ahrena Console', url: 'https://github.com/orgs/ahrenatechnology/projects/3' },
    statuses: STATUSES,
    nodes,
    sessions: [],
    queue: new Map(),
    queueAvailable: false,
    since: new Map(),
    filters: filters(),
    now: NOW,
    fetchedAt: NOW,
    stale: false,
    staleReason: null,
    retryAt: null,
    ...over,
  });
}

const allCards = (view: WorkBoardView): WorkBoardCard[] => view.columns.flatMap((c) => c.cards);
const card = (view: WorkBoardView, n: number): WorkBoardCard => {
  const hit = allCards(view).find((c) => c.number === n);
  assert.ok(hit, `card #${n} is on the board`);
  return hit;
};
const numbersIn = (view: WorkBoardView, column: string) => view.columns.find((c) => c.id === column)!.cards.map((c) => c.number);

describe('work board vocabulary', () => {
  test('the six columns in lifecycle order, with pt-BR label and criterion as data', () => {
    assert.deepEqual(WORK_BOARD_COLUMNS.map((c) => c.id), ['planning', 'queued', 'running', 'review', 'blocked', 'done']);
    assert.deepEqual(WORK_BOARD_COLUMNS.map((c) => c.label), ['Planejamento', 'Na fila', 'Em execução', 'Em review', 'Bloqueado', 'Concluído']);
    assert.ok(WORK_BOARD_COLUMNS.every((c) => c.criterion.length > 0));
  });

  test('the three blocked reasons in their sort order, and the limits', () => {
    assert.deepEqual(WORK_BLOCKED_REASONS.map((r) => [r.id, r.label]), [
      ['needs-you', 'Precisa de você'],
      ['review-rounds', 'Mudança pedida depois de 3 rodadas'],
      ['ci-failed', 'CI falhou'],
    ]);
    assert.equal(REVIEW_ROUNDS_LIMIT, 3);
    assert.equal(DONE_WINDOW_DAYS, 14);
  });

  test('#466/AC-3 status slug: diacritics stripped, lower case, runs of other characters become one dash, trimmed', () => {
    assert.equal(statusSlug('In Progress'), 'in-progress');
    assert.equal(statusSlug('  Todo  '), 'todo');
    assert.equal(statusSlug('Em revisão / QA!'), 'em-revisao-qa');
    assert.equal(statusSlug('Concluído'), 'concluido');
    assert.equal(statusSlug('✅ Done'), 'done');
    assert.equal(statusSlug('✅'), '');
  });

  test('#466/AC-3 a status with no ASCII left falls back to a stable slug from its option id', () => {
    const index = statusIndex([{ id: 'F75AD846', name: '✅' }, { id: '+', name: '🚧' }, { id: '~', name: '' }]);
    assert.deepEqual([...index.values()], [
      { id: 'status-f75ad846', name: '✅' },
      { id: 'status-1f6a7', name: '🚧' },
      { id: 'status-option', name: '' },
    ]);
  });

  test('#466/AC-3 colliding status slugs are told apart by option id, then by number, in Project order', () => {
    const options = [
      { id: 'a1', name: 'Done' },
      { id: 'b2', name: '✅ Done' },
      { id: 'c3', name: 'No status' },
      { id: '+', name: 'done' },
      { id: '~', name: 'Dône' },
    ];
    const slugs = [...statusIndex(options).values()].map((s) => s.id);
    assert.deepEqual(slugs, ['done', 'done-b2', 'no-status-c3', 'done-2', 'done-3']);
    assert.deepEqual([...statusIndex(options).values()].map((s) => s.id), slugs);
  });

  test('#466/AC-3 an emoji-only status can be listed and selected', () => {
    const statuses = [...STATUSES, { id: 'opt-ship', name: '🚀' }];
    const nodes = [boardNode(1, { statusId: 'opt-ship' }), boardNode(2, { statusId: 'opt-todo' })];
    const view = board(nodes, { statuses });
    assert.deepEqual(view.options.statuses.at(-1), { id: 'status-opt-ship', name: '🚀', count: 1 });
    const parsed = parseWorkBoardFilters(new URLSearchParams('status=status-opt-ship'));
    assert.ok(!('error' in parsed));
    const chosen = board(nodes, { statuses, filters: parsed });
    assert.deepEqual(allCards(chosen).map((c) => c.number), [1]);
    assert.deepEqual(card(chosen, 1).projectStatus, { id: 'status-opt-ship', name: '🚀' });
  });

  test('type slugs group the GitHub issue types; an unknown type has no slug', () => {
    assert.deepEqual(['User Story', 'Story', 'Feature'].map(typeSlugOf), ['story', 'story', 'story']);
    assert.deepEqual(['Task', 'Tech Task'].map(typeSlugOf), ['task', 'task']);
    assert.deepEqual(['Epic', 'Epic / Milestone', 'Milestone'].map(typeSlugOf), ['epic', 'epic', 'epic']);
    assert.deepEqual(['Spike', 'Bug', 'Initiative', 'Plan'].map(typeSlugOf), ['spike', 'bug', 'initiative', 'plan']);
    assert.equal(typeSlugOf('Chore'), null);
    assert.equal(typeSlugOf(null), null);
  });

  test('the empty queue has no positions and says it is not available', async () => {
    assert.equal(EMPTY_WORK_QUEUE.available, false);
    assert.equal((await EMPTY_WORK_QUEUE.positions()).size, 0);
  });
});

describe('column of one issue (epic #464 table)', () => {
  const open = { state: 'OPEN' as const, pullRequest: null, sessions: [], queuePosition: null };

  test('#465/AC-2 planning: open, no session, no PR, out of the queue', () => {
    assert.deepEqual(columnOfIssue(open), { column: 'planning', blocked: null });
  });

  test('#465/AC-2 planning: item with plan and no session stays in planning with plan.steps', () => {
    const view = board([boardNode(500, { subIssues: { total: 4, completed: 1 } })]);
    const c = card(view, 500);
    assert.equal(c.column, 'planning');
    assert.deepEqual(c.plan, { steps: 4 });
  });

  test('#465/AC-2 queued: a queue position puts an unstarted issue in the queue', () => {
    assert.equal(columnOfIssue({ ...open, queuePosition: 2 }).column, 'queued');
    const view = board([boardNode(500)], { queue: new Map([[k(500), 2]]) });
    assert.deepEqual([card(view, 500).column, card(view, 500).queuePosition], ['queued', 2]);
  });

  test('#477 queue keys are compared in lower case, like session keys', () => {
    const view = board([boardNode(502, { key: 'Acme/App#502', repo: 'Acme/App' })], { queue: new Map([['acme/app#502', 1]]) });
    assert.deepEqual([card(view, 502).column, card(view, 502).queuePosition], ['queued', 1]);
  });

  test('#465/AC-2 running: a working session moves the issue to running, even when queued', () => {
    assert.equal(columnOfIssue({ ...open, sessions: ['working'], queuePosition: 1 }).column, 'running');
  });

  test('#465/AC-2 running: a working agent on a PR with failed CI is running, not blocked', () => {
    assert.equal(columnOfIssue({ ...open, sessions: ['working'], pullRequest: pr({ ci: 'FAILURE' }) }).column, 'running');
  });

  test('#465/AC-2 review: an open PR, draft or not, without a working session', () => {
    assert.equal(columnOfIssue({ ...open, pullRequest: pr() }).column, 'review');
    assert.equal(columnOfIssue({ ...open, pullRequest: pr({ isDraft: true }) }).column, 'review');
    assert.equal(columnOfIssue({ ...open, sessions: ['idle'], pullRequest: pr({ ci: 'PENDING' }) }).column, 'review');
  });

  test('#465/AC-2 blocked: a linked session that needs the person', () => {
    assert.deepEqual(columnOfIssue({ ...open, sessions: ['needs-you'] }), { column: 'blocked', blocked: 'needs-you' });
  });

  test('#465/AC-2 done: issue closed, or its PR merged, wins over every other signal', () => {
    assert.equal(columnOfIssue({ ...open, state: 'CLOSED', sessions: ['needs-you'] }).column, 'done');
    assert.equal(columnOfIssue({ ...open, pullRequest: pr({ state: 'MERGED' }), sessions: ['working'] }).column, 'done');
    const view = board([
      boardNode(1, { pullRequest: pr({ state: 'MERGED', mergedAt: daysAgo(1) }) }),
      boardNode(2, { state: 'CLOSED', closedAt: daysAgo(2) }),
    ]);
    assert.deepEqual([card(view, 1).doneBy, card(view, 1).doneAt], ['merged', daysAgo(1)]);
    assert.deepEqual([card(view, 2).doneBy, card(view, 2).doneAt], ['closed', daysAgo(2)]);
  });

  test('#465/AC-2 two sessions: the card takes the most advanced one and counts both', () => {
    const view = board([boardNode(500), boardNode(501)], {
      sessions: [session('a', 500, 'idle'), session('b', 500, 'working'), session('c', 501, 'working'), session('d', 501, 'needs-you')],
    });
    assert.deepEqual([card(view, 500).column, card(view, 500).sessions], ['running', { count: 2, state: 'working', ids: ['a', 'b'] }]);
    assert.deepEqual([card(view, 501).column, card(view, 501).sessions.count, card(view, 501).sessions.state], ['blocked', 2, 'needs-you']);
  });

  test('an idle session does not move the card', () => {
    const view = board([boardNode(500)], { sessions: [session('a', 500, 'idle')] });
    assert.deepEqual([card(view, 500).column, card(view, 500).sessions], ['planning', { count: 1, state: 'idle', ids: ['a'] }]);
  });

  test('a closed PR alone does not put the issue in review', () => {
    assert.equal(columnOfIssue({ ...open, pullRequest: pr({ state: 'CLOSED' }) }).column, 'planning');
  });
});

describe('blocked reasons', () => {
  const open = { state: 'OPEN' as const, pullRequest: null, sessions: [], queuePosition: null };

  test('#465/AC-3 needs-you: a session waiting for the person, with the reason label on the card', () => {
    const view = board([boardNode(500)], { sessions: [session('a', 500, 'needs-you')] });
    assert.deepEqual(card(view, 500).blocked, { reason: 'needs-you', label: 'Precisa de você' });
  });

  test('#465 a session links to its issue whatever the case of the repo: sessions carry the lower-cased git remote', () => {
    const mixed = boardNode(501, { key: 'Acme/App#501', repo: 'Acme/App' });
    const view = board([mixed], { sessions: [{ sessionId: 'a', key: 'acme/app#501', state: 'needs-you', since: daysAgo(0) }] });
    assert.equal(card(view, 501).column, 'blocked');
    assert.deepEqual(card(view, 501).sessions.ids, ['a']);
  });

  test('#465/AC-3 review-rounds: changes requested after the third round, not before', () => {
    const changes = (n: number) => pr({ review: 'CHANGES_REQUESTED', changesRequested: n });
    assert.deepEqual(columnOfIssue({ ...open, pullRequest: changes(REVIEW_ROUNDS_LIMIT) }), { column: 'blocked', blocked: 'review-rounds' });
    assert.deepEqual(columnOfIssue({ ...open, pullRequest: changes(REVIEW_ROUNDS_LIMIT - 1) }), { column: 'review', blocked: null });
    assert.equal(columnOfIssue({ ...open, pullRequest: pr({ review: 'CHANGES_REQUESTED' }) }).column, 'review');
  });

  test('#465/AC-3 ci-failed: the last commit CI failed or errored on the open PR', () => {
    assert.deepEqual(columnOfIssue({ ...open, pullRequest: pr({ ci: 'FAILURE' }) }), { column: 'blocked', blocked: 'ci-failed' });
    assert.deepEqual(columnOfIssue({ ...open, pullRequest: pr({ ci: 'ERROR' }) }), { column: 'blocked', blocked: 'ci-failed' });
  });

  test('#465/AC-3 precedence among reasons: needs-you, then review rounds, then CI', () => {
    const worst = pr({ ci: 'FAILURE', review: 'CHANGES_REQUESTED', changesRequested: 5 });
    assert.equal(columnOfIssue({ ...open, pullRequest: worst }).blocked, 'review-rounds');
    assert.equal(columnOfIssue({ ...open, pullRequest: worst, sessions: ['needs-you'] }).blocked, 'needs-you');
  });

  test('#465/AC-3 order inside Bloqueado: reason order first, then oldest in the column', () => {
    const nodes = [
      boardNode(10, { pullRequest: pr({ ci: 'FAILURE' }) }),
      boardNode(11, { pullRequest: pr({ ci: 'FAILURE' }) }),
      boardNode(12, { pullRequest: pr({ review: 'CHANGES_REQUESTED', changesRequested: 3 }) }),
      boardNode(13),
      boardNode(14),
    ];
    const since = new Map([
      [k(10), daysAgo(1)],
      [k(11), daysAgo(3)],
      [k(12), daysAgo(9)],
      [k(13), daysAgo(1)],
      [k(14), daysAgo(2)],
    ]);
    const view = board(nodes, { since, sessions: [session('a', 13, 'needs-you'), session('b', 14, 'needs-you')] });
    assert.deepEqual(numbersIn(view, 'blocked'), [14, 13, 12, 11, 10]);
  });
});

describe('column of an epic or initiative (rollup of its direct children)', () => {
  const r = (column: string, blocked: string | null = null) => ({ column, blocked }) as ReturnType<typeof columnOfIssue>;

  test('#465/AC-2 epic rollup follows the wireframe cases', () => {
    assert.equal(columnOfParent('OPEN', [r('planning'), r('planning'), r('planning'), r('planning')]).column, 'planning');
    assert.equal(columnOfParent('OPEN', [r('planning'), r('planning'), r('running'), r('review'), r('done')]).column, 'running');
    assert.equal(columnOfParent('OPEN', [r('review'), r('review'), r('done')]).column, 'review');
    assert.equal(columnOfParent('OPEN', [r('queued'), r('planning')]).column, 'queued');
    assert.equal(columnOfParent('OPEN', [r('done'), r('done')]).column, 'done');
    assert.equal(columnOfParent('CLOSED', [r('planning')]).column, 'done');
  });

  test('#465/AC-2 epic rollup: any blocked child blocks the epic with the first reason in reason order', () => {
    assert.deepEqual(columnOfParent('OPEN', [r('running'), r('blocked', 'ci-failed'), r('blocked', 'review-rounds'), r('done')]), {
      column: 'blocked',
      blocked: 'review-rounds',
    });
  });

  test('#465/AC-2 epic rollup on the board: bottom-up, with the children summary on the card', () => {
    const nodes = [
      boardNode(1, { type: 'Initiative' }),
      boardNode(6, { type: 'Epic', parent: k(1) }),
      boardNode(7, { type: 'Epic', parent: k(1) }),
      boardNode(60, { parent: k(6), pullRequest: pr() }),
      boardNode(61, { parent: k(6), state: 'CLOSED', closedAt: daysAgo(1) }),
      boardNode(62, { parent: k(6) }),
      boardNode(70, { parent: k(7), pullRequest: pr({ ci: 'ERROR' }) }),
    ];
    const epics = board(nodes, { filters: filters({ level: 'epic' }) });
    assert.equal(card(epics, 6).column, 'review');
    assert.deepEqual(card(epics, 6).children, { total: 3, done: 1, byColumn: { review: 1, done: 1, planning: 1 }, blocked: {} });
    assert.deepEqual([card(epics, 7).column, card(epics, 7).blocked?.reason], ['blocked', 'ci-failed']);
    assert.deepEqual(card(epics, 7).children?.blocked, { 'ci-failed': 1 });
    const initiatives = board(nodes, { filters: filters({ level: 'initiative' }) });
    assert.deepEqual([card(initiatives, 1).column, card(initiatives, 1).blocked?.reason], ['blocked', 'ci-failed']);
    assert.equal(card(board(nodes), 60).children, null);
  });

  test('an epic with no children on the board uses the leaf rule', () => {
    const view = board([boardNode(6, { type: 'Epic', pullRequest: pr() })], { filters: filters({ level: 'epic' }) });
    assert.equal(card(view, 6).column, 'review');
  });
});

describe('ordering, time in column and the done window', () => {
  test('planning newest first, queued by position, running and review oldest first, done newest first; ties by number', () => {
    const nodes = [
      boardNode(1),
      boardNode(2),
      boardNode(3),
      boardNode(4),
      boardNode(5),
      boardNode(6),
      boardNode(7, { pullRequest: pr() }),
      boardNode(8, { pullRequest: pr() }),
      boardNode(9, { state: 'CLOSED', closedAt: daysAgo(3) }),
      boardNode(10, { state: 'CLOSED', closedAt: daysAgo(1) }),
      boardNode(11, { state: 'CLOSED', closedAt: null }),
    ];
    const since = new Map([
      [k(1), daysAgo(5)],
      [k(2), daysAgo(1)],
      [k(5), daysAgo(1)],
      [k(6), daysAgo(4)],
      [k(7), daysAgo(1)],
      [k(8), daysAgo(2)],
    ]);
    const view = board(nodes, {
      since,
      queue: new Map([[k(3), 2], [k(4), 1]]),
      sessions: [session('a', 5, 'working'), session('b', 6, 'working')],
    });
    assert.deepEqual(numbersIn(view, 'planning'), [2, 1]);
    assert.deepEqual(numbersIn(view, 'queued'), [4, 3]);
    assert.deepEqual(numbersIn(view, 'running'), [6, 5]);
    assert.deepEqual(numbersIn(view, 'review'), [8, 7]);
    assert.deepEqual(numbersIn(view, 'done'), [10, 9, 11]);
    assert.equal(card(view, 1).columnSince, daysAgo(5));
    assert.equal(card(view, 3).columnSince, null);
  });

  test('done cards older than the window are left out; unknown doneAt is kept', () => {
    const view = board([
      boardNode(1, { state: 'CLOSED', closedAt: daysAgo(DONE_WINDOW_DAYS + 1) }),
      boardNode(2, { pullRequest: pr({ state: 'MERGED', mergedAt: daysAgo(DONE_WINDOW_DAYS - 1) }) }),
      boardNode(3, { state: 'CLOSED' }),
    ]);
    assert.deepEqual(numbersIn(view, 'done'), [2, 3]);
    assert.equal(view.columns.find((c) => c.id === 'done')!.count, 2);
    assert.equal(view.doneWindowDays, DONE_WINDOW_DAYS);
  });

  test('a done card with no doneAt ages out of the window by its column time', () => {
    const children = (parent: number, first: number) => [
      boardNode(first, { parent: k(parent), state: 'CLOSED', closedAt: daysAgo(DONE_WINDOW_DAYS + 5) }),
      boardNode(first + 1, { parent: k(parent), state: 'CLOSED', closedAt: daysAgo(DONE_WINDOW_DAYS + 5) }),
    ];
    const view = board(
      [
        boardNode(1, { type: 'Epic' }),
        ...children(1, 10),
        boardNode(2, { type: 'Epic' }),
        ...children(2, 20),
        boardNode(3, { type: 'Epic' }),
        ...children(3, 30),
      ],
      {
        filters: filters({ level: 'epic' }),
        since: new Map([
          [k(1), daysAgo(DONE_WINDOW_DAYS + 1)],
          [k(2), daysAgo(DONE_WINDOW_DAYS - 1)],
        ]),
      },
    );
    assert.equal(card(view, 2).doneAt, null);
    assert.deepEqual(numbersIn(view, 'done'), [2, 3]);
  });

  test('the view always carries the six columns in order, the reasons and the queue availability', () => {
    const view = board([]);
    assert.deepEqual(view.columns.map((c) => [c.id, c.count]), WORK_BOARD_COLUMNS.map((c) => [c.id, 0]));
    assert.deepEqual(view.blockedReasons, WORK_BLOCKED_REASONS.map(({ id, label }) => ({ id, label })));
    assert.deepEqual(view.queue, { available: false });
    assert.deepEqual(view.levels, [...WORK_LEVELS]);
  });
});

describe('card contents', () => {
  test('pull request with ci and review in the panel value sets, and the project status as data', () => {
    const view = board([
      boardNode(1, { statusId: 'opt-progress', labels: ['ui'], milestone: 'M1', pullRequest: pr({ ci: 'SUCCESS', review: 'APPROVED' }) }),
      boardNode(2, { pullRequest: pr({ isDraft: true, ci: 'PENDING' }) }),
      boardNode(3, { pullRequest: pr({ state: 'MERGED', review: 'CHANGES_REQUESTED', changesRequested: 1, ci: 'FAILURE' }) }),
      boardNode(4, { statusId: 'gone-option' }),
    ]);
    const c1 = card(view, 1);
    assert.deepEqual(c1.pullRequest, { number: 900, url: `https://github.com/${REPO}/pull/900`, state: 'open', ci: 'ok', review: 'approved', changesRequested: 0 });
    assert.deepEqual([c1.projectStatus, c1.labels, c1.milestone, c1.type, c1.typeName, c1.state], [{ id: 'in-progress', name: 'In Progress' }, ['ui'], 'M1', 'task', 'Task', 'open']);
    assert.deepEqual([card(view, 2).pullRequest?.state, card(view, 2).pullRequest?.ci, card(view, 2).pullRequest?.review], ['draft', 'running', 'pending']);
    assert.deepEqual([card(view, 3).pullRequest?.state, card(view, 3).pullRequest?.ci, card(view, 3).pullRequest?.review, card(view, 3).pullRequest?.changesRequested], ['merged', 'failed', 'changes-requested', 1]);
    assert.equal(card(view, 4).projectStatus, null);
  });

  test('project header with the most frequent repository of the issues', () => {
    const view = board([boardNode(1), boardNode(2), boardNode(3, { repo: 'ahrenatechnology/other', key: 'ahrenatechnology/other#3' })]);
    assert.deepEqual(view.project, { owner: 'ahrenatechnology', number: 3, title: 'Ahrena Console', url: 'https://github.com/orgs/ahrenatechnology/projects/3', primaryRepo: REPO });
  });
});

describe('levels (#466)', () => {
  const tree = [
    boardNode(1, { type: 'Initiative' }),
    boardNode(6, { type: 'Epic', parent: k(1) }),
    boardNode(500, { type: 'Bug', parent: k(6) }),
    boardNode(501, { type: null, parent: k(6) }),
    boardNode(502, { type: null, parent: k(500) }),
    boardNode(503, { type: null }),
  ];

  test('#466/AC-2 the four levels come from WORK_LEVELS and switching level shows that level\'s nodes', () => {
    const shown = Object.fromEntries(WORK_LEVELS.map((level) => [level, allCards(board(tree, { filters: filters({ level }) })).map((c) => c.number).sort((a, b) => a - b)]));
    assert.deepEqual(shown, { initiative: [1], epic: [6], item: [500, 501, 503], plan: [502] });
    assert.ok(allCards(board(tree, { filters: filters({ level: 'plan' }) })).every((c) => c.level === 'plan'));
  });

  test('#466/AC-2 total counts the level before filters and matched after them', () => {
    const view = board(tree, { filters: filters({ type: 'bug' }) });
    assert.deepEqual([view.total, view.matched], [3, 1]);
  });

  test('a parent resolved outside the Project gives the chain but no card', () => {
    const view = board([boardNode(6, { type: 'Epic', inProject: false }), boardNode(500, { parent: k(6) })], { filters: filters({ level: 'epic' }) });
    assert.deepEqual(allCards(view), []);
  });
});

describe('parent chain (#466)', () => {
  test('#466/AC-4 the card carries its ancestors root first, and the parent is the last one', () => {
    const nodes = [
      boardNode(1, { type: 'Initiative', title: 'Console' }),
      boardNode(6, { type: 'Epic', parent: k(1), title: 'Quadro' }),
      boardNode(500, { parent: k(6) }),
    ];
    const view = board(nodes);
    const c = card(view, 500);
    assert.deepEqual(c.chain, [
      { key: k(1), number: 1, title: 'Console', level: 'initiative' },
      { key: k(6), number: 6, title: 'Quadro', level: 'epic' },
    ]);
    assert.deepEqual(c.parent, { key: k(6), number: 6 });
    const root = card(board(nodes, { filters: filters({ level: 'initiative' }) }), 1);
    assert.deepEqual([root.parent, root.chain], [null, []]);
  });

  test('#466/AC-4 a parent that never arrived stays in the chain with no title', () => {
    const c = card(board([boardNode(500, { parent: k(6) })]), 500);
    assert.deepEqual(c.chain, [{ key: k(6), number: 6, title: null, level: 'epic' }]);
  });

  test('a cycle among parents does not loop', () => {
    const view = board([boardNode(1, { parent: k(2) }), boardNode(2, { parent: k(1) })]);
    assert.equal(allCards(view).length, 2);
  });
});

describe('filters (#466)', () => {
  test('#466/AC-3 parsing from English query params, with level item by default', () => {
    assert.deepEqual(parseWorkBoardFilters(new URLSearchParams('')), filters());
    assert.deepEqual(
      parseWorkBoardFilters(new URLSearchParams('level=plan&initiative=1&epic=6&type=bug&label=UI&repo=ahrena-console&status=in-progress')),
      { level: 'plan', initiative: 1, epic: 6, type: 'bug', label: 'UI', repo: 'ahrena-console', status: 'in-progress' },
    );
    assert.deepEqual(parseWorkBoardFilters(new URLSearchParams('label=&repo=')), filters());
  });

  test('#466/AC-3 initiative and epic accept a number or an issue key', () => {
    const parsed = parseWorkBoardFilters(new URLSearchParams(`initiative=${encodeURIComponent('ahrenatechnology/ahrena-console#1')}&epic=6`));
    assert.deepEqual(parsed, filters({ initiative: k(1), epic: 6 }));
    for (const v of ['ahrena-console#6', 'a/b#0', 'a/b#06', 'a/b#x', 'a/b/c#6', '#6']) {
      assert.deepEqual(parseWorkBoardFilters(new URLSearchParams({ epic: v })), { error: 'bad-filter', param: 'epic' }, v);
    }
  });

  test('#466/AC-3 a bad level, number or type is a bad-filter naming the param', () => {
    assert.deepEqual(parseWorkBoardFilters(new URLSearchParams('level=nivel')), { error: 'bad-filter', param: 'level' });
    assert.deepEqual(parseWorkBoardFilters(new URLSearchParams('epic=seis')), { error: 'bad-filter', param: 'epic' });
    assert.deepEqual(parseWorkBoardFilters(new URLSearchParams('initiative=0')), { error: 'bad-filter', param: 'initiative' });
    assert.deepEqual(parseWorkBoardFilters(new URLSearchParams('type=chore')), { error: 'bad-filter', param: 'type' });
  });

  const OTHER = 'ahrenatechnology/ahrena-framework';
  const nodes = [
    boardNode(1, { type: 'Initiative', title: 'Console' }),
    boardNode(2, { type: 'Initiative', title: 'Framework' }),
    boardNode(6, { type: 'Epic', parent: k(1), title: 'Quadro' }),
    boardNode(7, { type: 'Epic', parent: k(1), title: 'Fila' }),
    boardNode(500, { type: 'Bug', parent: k(6), labels: ['UI'], statusId: 'opt-todo' }),
    boardNode(501, { type: 'Task', parent: k(6), labels: ['backend'], statusId: 'opt-progress' }),
    boardNode(502, { type: 'Bug', parent: k(7), labels: ['ui', 'backend'] }),
    boardNode(503, { type: 'Chore', statusId: 'opt-todo' }),
    { ...boardNode(20, { type: 'Bug', parent: k(2), labels: ['UI'] }), key: `${OTHER}#20`, repo: OTHER },
  ];
  const shown = (over: Partial<WorkBoardFilters>) => allCards(board(nodes, { filters: filters(over) })).map((c) => c.number).sort((a, b) => a - b);

  test('#466/AC-3 each filter on its own', () => {
    assert.deepEqual(shown({ initiative: 1 }), [500, 501, 502]);
    assert.deepEqual(shown({ epic: 6 }), [500, 501]);
    assert.deepEqual(shown({ type: 'bug' }), [20, 500, 502]);
    assert.deepEqual(shown({ label: 'ui' }), [20, 500, 502]);
    assert.deepEqual(shown({ repo: 'AHRENA-FRAMEWORK' }), [20]);
    assert.deepEqual(shown({ repo: OTHER }), [20]);
    assert.deepEqual(shown({ status: 'todo' }), [500, 503]);
    assert.deepEqual(shown({ status: 'no-status' }), [20, 502]);
  });

  test('#466/AC-3 the initiative and epic filters include the node itself at its own level', () => {
    assert.deepEqual(allCards(board(nodes, { filters: filters({ level: 'epic', epic: 6 }) })).map((c) => c.number), [6]);
    assert.deepEqual(allCards(board(nodes, { filters: filters({ level: 'initiative', initiative: 2 }) })).map((c) => c.number), [2]);
  });

  test('#466/AC-3 filters combine by AND', () => {
    assert.deepEqual(shown({ initiative: 1, epic: 6, type: 'bug' }), [500]);
    assert.deepEqual(shown({ type: 'bug', label: 'ui', repo: 'ahrena-console' }), [500, 502]);
    assert.deepEqual(shown({ epic: 7, status: 'todo' }), []);
  });

  test('#466/AC-3 options count the nodes of the level that match all the other filters', () => {
    const view = board(nodes, { filters: filters({ epic: 6, label: 'ui' }) });
    assert.deepEqual(view.options.types, [{ id: 'bug', count: 1 }]);
    assert.deepEqual(view.options.labels, [{ name: 'backend', count: 1 }, { name: 'UI', count: 1 }]);
    assert.deepEqual(view.options.epics, [
      { key: k(6), repo: REPO, number: 6, title: 'Quadro', count: 1 },
      { key: k(7), repo: REPO, number: 7, title: 'Fila', count: 1 },
    ]);
    assert.deepEqual(view.options.initiatives, [{ key: k(1), repo: REPO, number: 1, title: 'Console', count: 1 }]);
    assert.deepEqual(view.options.repos, [{ name: REPO, count: 1 }]);
    assert.deepEqual(view.options.statuses, [
      { id: 'todo', name: 'Todo', count: 1 },
      { id: 'in-progress', name: 'In Progress', count: 0 },
      { id: 'done', name: 'Done', count: 0 },
    ]);
    assert.deepEqual(view.filters, filters({ epic: 6, label: 'ui' }));
  });

  test('#466/AC-3 two repos with the same epic number: a key filter keeps them apart, a number matches both', () => {
    const other = (n: number, over: Partial<WorkBoardNode> = {}) => ({ ...boardNode(n, over), key: `${OTHER}#${n}`, repo: OTHER });
    const twoRepos = [
      boardNode(6, { type: 'Epic', title: 'Quadro' }),
      other(6, { type: 'Epic', title: 'Regras' }),
      boardNode(500, { parent: k(6) }),
      other(600, { parent: `${OTHER}#6` }),
    ];
    const shownIn = (epic: WorkBoardFilters['epic']) => allCards(board(twoRepos, { filters: filters({ epic }) })).map((c) => c.key).sort();
    assert.deepEqual(shownIn(k(6)), [k(500)]);
    assert.deepEqual(shownIn(`${OTHER.toUpperCase()}#6`), [`${OTHER}#600`]);
    assert.deepEqual(shownIn(6), [k(500), `${OTHER}#600`]);
    assert.deepEqual(board(twoRepos).options.epics, [
      { key: k(6), repo: REPO, number: 6, title: 'Quadro', count: 1 },
      { key: `${OTHER}#6`, repo: OTHER, number: 6, title: 'Regras', count: 1 },
    ]);
  });

  test('#466/AC-3 the statuses option ends with no-status when some node has none', () => {
    const view = board(nodes);
    assert.deepEqual(view.options.statuses.at(-1), { id: 'no-status', name: 'Sem status', count: 2 });
  });

  test('#466/AC-3 a label nobody has empties every column but keeps the options to clear it', () => {
    const view = board(nodes, { filters: filters({ label: 'nobody' }) });
    assert.deepEqual([view.matched, allCards(view).length, view.total], [0, 0, 5]);
    assert.deepEqual(view.options.labels, [{ name: 'backend', count: 2 }, { name: 'UI', count: 3 }]);
  });
});

describe('counts without each active filter (#501)', () => {
  const OTHER = 'ahrenatechnology/framework-x';
  const other = (n: number, over: Partial<WorkBoardNode> = {}) => ({ ...boardNode(n, over), key: `${OTHER}#${n}`, repo: OTHER });
  const closed = (days: number) => ({ state: 'CLOSED' as const, closedAt: daysAgo(days) });
  // #501 type=bug and repo=ahrena-console match no card together: the bugs live in OTHER, the tasks in REPO.
  const nodes = [
    boardNode(1),
    boardNode(2),
    boardNode(3, closed(2)),
    boardNode(4, closed(30)),
    other(20, { type: 'Bug' }),
    other(21, { type: 'Bug' }),
    other(22, { type: 'Bug', ...closed(40) }),
  ];

  test('#501/AC-1 two filters with no result: each count is the cards that appear without that filter', () => {
    const view = board(nodes, { filters: filters({ type: 'bug', repo: 'ahrena-console' }) });
    assert.equal(view.matched, 0);
    assert.equal(allCards(view).length, 0);
    assert.deepEqual(view.countsWithoutFilter, { type: 3, repo: 2 });
  });

  test('#501/AC-1 a done card older than the 14-day window is not counted', () => {
    const view = board(nodes, { filters: filters({ type: 'bug', repo: 'ahrena-console' }) });
    // repo alone: #1, #2 open and #3 done 2 days ago; #4 done 30 days ago is out.
    assert.equal(view.countsWithoutFilter.type, 3);
    // type alone: #20, #21; #22 done 40 days ago is out.
    assert.equal(view.countsWithoutFilter.repo, 2);
  });

  test('#501/AC-2 an inactive filter has no entry', () => {
    const view = board(nodes, { filters: filters({ type: 'bug', repo: 'ahrena-console' }) });
    assert.deepEqual(Object.keys(view.countsWithoutFilter).sort(), ['repo', 'type']);
    for (const key of ['initiative', 'epic', 'label', 'status']) assert.ok(!(key in view.countsWithoutFilter), key);
  });

  test('#501/AC-2 with no filter active the field is present and empty', () => {
    assert.deepEqual(board(nodes).countsWithoutFilter, {});
  });
});

describe('issue of a session prompt', () => {
  test('a full reference owner/name#n', () => {
    assert.equal(issueOfPrompt('trabalhe na ahrenatechnology/ahrena-framework#12 agora', REPO), 'ahrenatechnology/ahrena-framework#12');
  });

  test('a github.com issue or pull URL', () => {
    assert.equal(issueOfPrompt('veja https://github.com/ahrenatechnology/ahrena-console/issues/465#issuecomment-1', null), `${REPO}#465`);
    assert.equal(issueOfPrompt('revise github.com/ahrenatechnology/ahrena-console/pull/480', null), `${REPO}#480`);
  });

  test('a bare #n goes to the session repository, and needs one', () => {
    assert.equal(issueOfPrompt('implemente a #465', REPO), k(465));
    assert.equal(issueOfPrompt('implemente a #465', null), null);
  });

  test('only the first reference counts', () => {
    assert.equal(issueOfPrompt('#465 e depois ahrenatechnology/ahrena-framework#12', REPO), k(465));
    assert.equal(issueOfPrompt('ahrenatechnology/ahrena-framework#12 e depois #465', REPO), 'ahrenatechnology/ahrena-framework#12');
  });

  test('no reference, or something that only looks like one', () => {
    assert.equal(issueOfPrompt('sem issue aqui', REPO), null);
    assert.equal(issueOfPrompt('a cor &#123; e abc#4', REPO), null);
  });
});
