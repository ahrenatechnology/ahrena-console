import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  DEFAULT_WORK_BOARD_FILTERS,
  EMPTY_WORK_QUEUE,
  WorkBoardService,
  type ParentLookup,
  type ProjectBoard,
  type ProjectCard,
  type WorkSessionLink,
  type WorkBoardCard,
  type WorkBoardFilters,
  type WorkBoardView,
  type WorkColumnHistory,
  type WorkColumnObservation,
  type WorkNode,
  type WorkProjectBoard,
  type WorkQueue,
  type WorkSessions,
} from '../../src/index.ts';
import { clock, k, node, REPO } from './helpers.ts';
import { trustOf } from '../fixtures.ts';

function projectCard(n: number, over: Partial<ProjectCard> = {}): ProjectCard {
  return {
    itemId: `item-${n}`,
    kind: 'Issue',
    key: k(n),
    repo: REPO,
    number: n,
    title: `issue ${n}`,
    url: `https://github.com/${REPO}/issues/${n}`,
    state: 'OPEN',
    updatedAt: '2026-10-18T10:00:00Z',
    type: 'Task',
    parent: null,
    statusId: 'opt-todo',
    milestone: null,
    subIssues: null,
    pullRequest: null,
    ...over,
  };
}

function projectBoard(items: ProjectCard[], over: Partial<ProjectBoard> = {}): ProjectBoard {
  return {
    owner: 'ahrenatechnology',
    number: 3,
    title: 'Ahrena Console',
    url: 'https://github.com/orgs/ahrenatechnology/projects/3',
    field: 'Status',
    lanes: [
      { id: null, name: 'Sem status', color: null, items: items.filter((i) => !i.statusId) },
      { id: 'opt-todo', name: 'Todo', color: 'GREEN', items: items.filter((i) => i.statusId === 'opt-todo') },
      { id: 'opt-done', name: 'Done', color: 'PURPLE', items: items.filter((i) => i.statusId === 'opt-done') },
    ],
    count: items.length,
    fetchedAt: Date.parse('2026-10-18T11:59:00Z'),
    stale: false,
    staleReason: null,
    staleCode: null,
    ...over,
  };
}

/** ADR-0015 `current` is what GitHub answers; `stored` what the snapshot has. */
class FakeProject implements WorkProjectBoard {
  calls: string[] = [];
  current: ProjectBoard = projectBoard([]);
  stored: ProjectBoard | null = null;
  async board({ force = false }: { force?: boolean } = {}): Promise<ProjectBoard> {
    this.calls.push(force ? 'board:force' : 'board');
    return this.current;
  }
  async snapshot(): Promise<ProjectBoard | null> {
    this.calls.push('snapshot');
    return this.stored;
  }
}

class FakeSessions implements WorkSessions {
  list: WorkSessionLink[] = [];
  reads = 0;
  async links(): Promise<WorkSessionLink[]> {
    this.reads++;
    return this.list;
  }
}

class FakeQueue implements WorkQueue {
  readonly available = true;
  map = new Map<string, number>();
  reads = 0;
  async positions(): Promise<ReadonlyMap<string, number>> {
    this.reads++;
    return this.map;
  }
}

class MemoryHistory implements WorkColumnHistory {
  rows = new Map<string, { column: string; since: string }>();
  observed: WorkColumnObservation[][] = [];
  async observe(observations: readonly WorkColumnObservation[]): Promise<Map<string, string>> {
    this.observed.push([...observations]);
    const out = new Map<string, string>();
    for (const o of observations) {
      const row = this.rows.get(o.key);
      const next = row && row.column === o.column ? row : { column: o.column, since: o.at };
      this.rows.set(o.key, next);
      out.set(o.key, next.since);
    }
    return out;
  }
}

class FakeParents implements ParentLookup {
  calls: (readonly string[])[] = [];
  known = new Map<string, WorkNode>();
  fail: Error | null = null;
  async nodes(keys: readonly string[]): Promise<WorkNode[]> {
    this.calls.push(keys);
    if (this.fail) throw this.fail;
    const out = new Map<string, WorkNode>();
    for (let key of keys) {
      for (let n = this.known.get(key); n && !out.has(key); n = n.parent ? this.known.get(n.parent) : undefined) {
        out.set(key, n);
        if (!n.parent) break;
        key = n.parent;
      }
    }
    return [...out.values()];
  }
}

function setup({ queue = EMPTY_WORK_QUEUE as WorkQueue, withParents = true } = {}) {
  /** #496 the lazy time sources: the cache's pause end and the sync's next read of the Project. */
  const retry = { pausedUntil: 0, nextRead: null as number | null };
  const now = clock();
  const logged: string[] = [];
  const project = new FakeProject();
  const sessions = new FakeSessions();
  const history = new MemoryHistory();
  const parents = new FakeParents();
  const service = new WorkBoardService({ trust: trustOf('ahrenatechnology'), project, sessions, queue, history, parents: withParents ? parents : undefined, now, pausedUntil: () => retry.pausedUntil, nextScheduledRead: () => retry.nextRead, log: (m) => logged.push(m) });
  return { now, project, sessions, history, parents, service, logged, retry };
}

const filters = (over: Partial<WorkBoardFilters> = {}): WorkBoardFilters => ({ ...DEFAULT_WORK_BOARD_FILTERS, ...over });
const cards = (view: WorkBoardView): WorkBoardCard[] => view.columns.flatMap((c) => c.cards);
const cardOf = (view: WorkBoardView, n: number): WorkBoardCard => {
  const hit = cards(view).find((c) => c.number === n);
  assert.ok(hit, `card #${n} is on the board`);
  return hit;
};
const link = (id: string, n: number, state: WorkSessionLink['state']): WorkSessionLink => ({ sessionId: id, key: k(n), state, since: '2026-10-18T11:00:00Z' });

describe('work board use case', () => {
  test('the behaviour scenario: #500 walks planning → running → review → done as the signals change', async () => {
    const { project, sessions, service } = setup();
    project.current = projectBoard([projectCard(500)]);
    assert.equal(cardOf(await service.board(filters()), 500).column, 'planning');
    sessions.list = [link('s1', 500, 'working')];
    assert.equal(cardOf(await service.board(filters()), 500).column, 'running');
    sessions.list = [link('s1', 500, 'idle')];
    project.current = projectBoard([projectCard(500, { pullRequest: { number: 9, url: 'u', state: 'OPEN', isDraft: false, review: 'REVIEW_REQUIRED', ci: 'PENDING' } })]);
    assert.equal(cardOf(await service.board(filters()), 500).column, 'review');
    project.current = projectBoard([projectCard(500, { pullRequest: { number: 9, url: 'u', state: 'MERGED', isDraft: false, review: 'APPROVED', ci: 'SUCCESS', mergedAt: '2026-10-18T11:30:00Z' } })]);
    const done = cardOf(await service.board(filters()), 500);
    assert.deepEqual([done.column, done.doneBy, done.doneAt, done.columnSince], ['done', 'merged', '2026-10-18T11:30:00Z', '2026-10-18T11:30:00Z']);
  });

  test('keeps only issues: pull requests and drafts in the Project are not cards', async () => {
    const { project, service } = setup();
    project.current = projectBoard([
      projectCard(1),
      projectCard(2, { kind: 'PullRequest' }),
      projectCard(0, { kind: 'DraftIssue', key: null, repo: null, number: null, url: null }),
    ]);
    const view = await service.board(filters());
    assert.deepEqual(cards(view).map((c) => c.number), [1]);
    assert.equal(view.total, 1);
  });

  test('labels, closedAt and the project status come from the Project card', async () => {
    const { project, service } = setup();
    project.current = projectBoard([projectCard(1, { labels: ['UI'], state: 'CLOSED', closedAt: '2026-10-17T12:00:00Z', statusId: 'opt-done' })]);
    const c = cardOf(await service.board(filters({ label: 'ui', status: 'done' })), 1);
    assert.deepEqual([c.labels, c.doneAt, c.doneBy, c.projectStatus], [['UI'], '2026-10-17T12:00:00Z', 'closed', { id: 'done', name: 'Done' }]);
  });

  test('observes the history with every node\'s column, Project parents included, and shows the time in column', async () => {
    const { now, project, sessions, history, service } = setup();
    project.current = projectBoard([projectCard(6, { type: 'Epic' }), projectCard(60, { parent: k(6) })]);
    const first = await service.board(filters());
    assert.deepEqual(history.observed[0].map((o) => [o.key, o.column, o.at]).sort(), [
      [k(6), 'planning', '2026-10-18T12:00:00.000Z'],
      [k(60), 'planning', '2026-10-18T12:00:00.000Z'],
    ]);
    assert.equal(cardOf(first, 60).columnSince, '2026-10-18T12:00:00.000Z');
    now.add(60_000);
    assert.equal(cardOf(await service.board(filters()), 60).columnSince, '2026-10-18T12:00:00.000Z');
    sessions.list = [link('s1', 60, 'working')];
    assert.equal(cardOf(await service.board(filters()), 60).columnSince, '2026-10-18T12:01:00.000Z');
  });

  test('sessions and the queue are read live on every board read', async () => {
    const queue = new FakeQueue();
    const { project, sessions, service } = setup({ queue });
    project.current = projectBoard([projectCard(1)]);
    queue.map.set(k(1), 1);
    const view = await service.board(filters());
    assert.deepEqual([cardOf(view, 1).column, view.queue], ['queued', { available: true }]);
    await service.board(filters());
    assert.deepEqual([sessions.reads, queue.reads], [2, 2]);
  });

  test('without the queue the board says it is not available', async () => {
    const { service } = setup();
    assert.deepEqual((await service.board(filters())).queue, { available: false });
  });
});

describe('reading the Project (decisions 0001 and 0015)', () => {
  test('fromStore answers the stored snapshot without calling GitHub', async () => {
    const { project, service } = setup();
    project.stored = projectBoard([projectCard(7)]);
    project.current = projectBoard([projectCard(8)]);
    const view = await service.board(filters(), { fromStore: true });
    assert.deepEqual([project.calls, cards(view).map((c) => c.number)], [['snapshot'], [7]]);
  });

  test('fromStore falls back to reading GitHub only when nothing is stored', async () => {
    const { project, service } = setup();
    project.current = projectBoard([projectCard(8)]);
    const view = await service.board(filters(), { fromStore: true });
    assert.deepEqual([project.calls, cards(view).map((c) => c.number)], [['snapshot', 'board'], [8]]);
  });

  test('force re-reads GitHub, even from the store', async () => {
    const { project, service } = setup();
    project.stored = projectBoard([projectCard(7)]);
    await service.board(filters(), { force: true, fromStore: true });
    assert.deepEqual(project.calls, ['board:force']);
  });

  test('#465/AC-4 GitHub down: the board keeps the last data with stale and the reason, while sessions still move the column', async () => {
    const { project, sessions, service } = setup();
    const fetchedAt = Date.parse('2026-10-18T11:00:00Z');
    project.current = projectBoard([projectCard(500)], { stale: true, staleReason: 'GitHub indisponível', staleCode: 'network', fetchedAt });
    const before = await service.board(filters());
    assert.deepEqual([before.stale, before.staleReason, before.fetchedAt, cardOf(before, 500).column], [true, 'network', fetchedAt, 'planning']);
    sessions.list = [link('s1', 500, 'needs-you')];
    const after = await service.board(filters());
    assert.deepEqual([after.stale, cardOf(after, 500).column, cardOf(after, 500).blocked?.reason], [true, 'blocked', 'needs-you']);
  });
});

describe('parents outside the Project', () => {
  test('#466/AC-4 a parent resolved through the lookup completes the chain, in one batched call', async () => {
    const { project, parents, service } = setup();
    parents.known.set(k(1), node(1, { type: 'Initiative', title: 'Console' }));
    parents.known.set(k(6), node(6, { type: 'Epic', parent: k(1), title: 'Quadro' }));
    project.current = projectBoard([projectCard(500, { parent: k(6) }), projectCard(501, { parent: k(6) })]);
    const view = await service.board(filters({ initiative: 1 }));
    assert.deepEqual(parents.calls, [[k(6)]]);
    assert.deepEqual(cardOf(view, 500).chain.map((c) => [c.number, c.title, c.level]), [[1, 'Console', 'initiative'], [6, 'Quadro', 'epic']]);
    assert.deepEqual(cards(view).map((c) => c.number).sort(), [500, 501]);
    assert.deepEqual(view.options.epics, [{ key: k(6), repo: REPO, number: 6, title: 'Quadro', count: 2 }]);
    assert.equal(view.stale, false);
  });

  test('parents outside the Project get no history rows', async () => {
    const { project, parents, history, service } = setup();
    parents.known.set(k(6), node(6, { type: 'Epic' }));
    project.current = projectBoard([projectCard(500, { parent: k(6) })]);
    await service.board(filters());
    assert.deepEqual(history.observed[0].map((o) => o.key), [k(500)]);
  });

  test('no lookup call when every parent is in the Project', async () => {
    const { project, parents, service } = setup();
    project.current = projectBoard([projectCard(6, { type: 'Epic' }), projectCard(60, { parent: k(6) })]);
    await service.board(filters());
    assert.deepEqual(parents.calls, []);
  });

  test('a failed lookup only makes the board stale, with the reason, and keeps the cards', async () => {
    const { project, parents, service, logged } = setup();
    parents.fail = new Error('rate limited');
    project.current = projectBoard([projectCard(500, { parent: k(6) })], { stale: true, staleReason: 'dado velho', staleCode: 'rate-limited' });
    const view = await service.board(filters());
    assert.equal(view.stale, true);
    assert.equal(view.staleReason, 'rate-limited', 'the Project code wins; the raw text stays in the log');
    assert.equal(logged.length, 2);
    assert.ok(logged.some((l) => /dado velho/.test(l)), 'the raw stale reason is logged');
    assert.ok(logged.some((l) => /rate limited/.test(l)));
    assert.deepEqual(cardOf(view, 500).chain, [{ key: k(6), number: 6, title: null, level: 'epic' }]);
  });

  test('#495/AC-1 a failed lookup on a fresh Project reports the code of its error, not its text', async () => {
    const { project, parents, service, logged } = setup();
    parents.fail = new TypeError('fetch failed');
    project.current = projectBoard([projectCard(500, { parent: k(6) })]);
    const view = await service.board(filters());
    assert.deepEqual([view.stale, view.staleReason], [true, 'network']);
    assert.match(logged[0], /fetch failed/);
  });

  test('without a lookup, a missing parent stays a chain link with no title', async () => {
    const { project, service } = setup({ withParents: false });
    project.current = projectBoard([projectCard(500, { parent: k(6) })]);
    const view = await service.board(filters());
    assert.deepEqual([cardOf(view, 500).chain[0].title, view.stale], [null, false]);
  });
});

describe('#496/AC-1 the work board says when the core tries GitHub again', () => {
  const stale = (project: FakeProject) => (project.current = projectBoard([projectCard(500)], { stale: true, staleReason: 'x', staleCode: 'network' }));

  test('#496/AC-1 Given the rate limit paused the cache, When the board is stale, Then retryAt is the end of the pause', async () => {
    const { now, project, service, retry } = setup();
    stale(project);
    retry.pausedUntil = now() + 600_000;
    retry.nextRead = now() + 120_000;
    assert.equal((await service.board(filters())).retryAt, now() + 600_000);
  });

  test('#496/AC-1 Given GitHub is down with no pause, When the board is stale, Then retryAt is the next scheduled read', async () => {
    const { now, project, service, retry } = setup();
    stale(project);
    retry.pausedUntil = now() - 1;
    retry.nextRead = now() + 90_000;
    assert.equal((await service.board(filters())).retryAt, now() + 90_000);
  });

  test('#496/AC-1 Given the next read is overdue, When the board is stale, Then retryAt is now, never in the past', async () => {
    const { now, project, service, retry } = setup();
    stale(project);
    retry.nextRead = now() - 30_000;
    assert.equal((await service.board(filters())).retryAt, now());
  });

  test('#496/AC-1 Given no read is scheduled, When the board is stale, Then retryAt is null', async () => {
    const { project, service } = setup();
    stale(project);
    assert.equal((await service.board(filters())).retryAt, null);
  });

  test('#496/AC-1 Given the board is not stale, Then retryAt is null even with a pause and a schedule', async () => {
    const { now, project, service, retry } = setup();
    project.current = projectBoard([projectCard(500)]);
    retry.pausedUntil = now() + 600_000;
    retry.nextRead = now() + 120_000;
    assert.equal((await service.board(filters())).retryAt, null);
  });
});
