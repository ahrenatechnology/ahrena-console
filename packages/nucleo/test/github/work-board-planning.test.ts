/*
 * #507 the planning state on the work board: `GET /api/work` gives the card `planning` while the planning
 * session runs, `plan: { steps }` once Plan sub-issues exist, and the failure reason when the session
 * ends without a plan. A planning session never moves the card out of Planejamento.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  DEFAULT_WORK_BOARD_FILTERS,
  EMPTY_WORK_QUEUE,
  WorkBoardService,
  type ProjectBoard,
  type ProjectCard,
  type WorkBoardCard,
  type WorkColumnHistory,
  type WorkProjectBoard,
  type WorkSessionLink,
  type WorkSessions,
} from '../../src/index.ts';
import { PLAN_SESSION_WINDOW_MS, type PlanRun, type WorkPlanRuns } from '../../src/github/work-plan.ts';
import { clock, k, REPO } from './helpers.ts';
import { trustOf } from '../fixtures.ts';

const START = '2026-10-18T12:00:00.000Z';

function card(n: number, over: Partial<ProjectCard> = {}): ProjectCard {
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
    type: 'User Story',
    parent: null,
    statusId: 'opt-todo',
    milestone: null,
    subIssues: null,
    pullRequest: null,
    ...over,
  };
}

const projectOf = (items: ProjectCard[]): ProjectBoard => ({
  owner: 'ahrenatechnology',
  number: 3,
  title: 'Ahrena Console',
  url: 'https://github.com/orgs/ahrenatechnology/projects/3',
  field: 'Status',
  lanes: [{ id: 'opt-todo', name: 'Todo', color: 'GREEN', items }],
  count: items.length,
  fetchedAt: Date.parse('2026-10-18T11:59:00Z'),
  stale: false,
  staleReason: null,
  staleCode: null,
});

class MemoryRuns implements WorkPlanRuns {
  rows = new Map<string, PlanRun>();
  saved: PlanRun[] = [];
  async get(key: string) {
    return this.rows.get(key.toLowerCase()) ?? null;
  }
  async all() {
    return [...this.rows.values()];
  }
  async save(run: PlanRun) {
    this.rows.set(run.key.toLowerCase(), run);
    this.saved.push(run);
  }
}

const history: WorkColumnHistory = { observe: async (os) => new Map(os.map((o) => [o.key, o.at])) };

function setup(withRuns = true) {
  const now = clock();
  let current = projectOf([card(412)]);
  const sessions = { list: [] as WorkSessionLink[] };
  const runs = new MemoryRuns();
  const project: WorkProjectBoard = { board: async () => current };
  const live: WorkSessions = { links: async () => sessions.list };
  const service = new WorkBoardService({ trust: trustOf('ahrenatechnology'), project, sessions: live, queue: EMPTY_WORK_QUEUE, history, now, ...(withRuns ? { planRuns: runs } : {}) });
  const read = async (): Promise<WorkBoardCard> => {
    const view = await service.board({ ...DEFAULT_WORK_BOARD_FILTERS });
    return view.columns.flatMap((c) => c.cards).find((c) => c.number === 412)!;
  };
  return { now, runs, sessions, read, set: (items: ProjectCard[]) => void (current = projectOf(items)) };
}

const running = (over: Partial<PlanRun> = {}): PlanRun => ({
  key: k(412),
  target: 'terminal',
  startedAt: START,
  replan: false,
  sessionId: null,
  outcome: 'running',
  failure: null,
  finishedAt: null,
  ...over,
});
const planningSession = (id: string, since = '2026-10-18T12:00:05.000Z'): WorkSessionLink => ({ sessionId: id, key: k(412), state: 'working', since, planning: true });

describe('#507/AC-3 the card while the planning session runs', () => {
  test('#507/AC-3 Given a run and its working planning session, Then the card is planning and stays in Planejamento, not Em execução', async () => {
    const t = setup();
    await t.runs.save(running());
    t.sessions.list = [planningSession('p1')];
    const c = await t.read();
    assert.deepEqual(c.planning, { state: 'running' });
    assert.equal(c.column, 'planning');
    assert.deepEqual(c.sessions, { count: 0, state: null, ids: [] });
    assert.equal((await t.runs.get(k(412)))?.sessionId, 'p1', 'the run remembers its session');
  });

  test('#507/AC-3 a planning session needing the person does not block the card either', async () => {
    const t = setup();
    await t.runs.save(running());
    t.sessions.list = [{ ...planningSession('p1'), state: 'needs-you' }];
    const c = await t.read();
    assert.equal(c.column, 'planning');
    assert.equal(c.blocked, null);
  });

  test('#507/AC-3 an execution session of the same issue still moves it, planning aside', async () => {
    const t = setup();
    await t.runs.save(running());
    t.sessions.list = [planningSession('p1'), { sessionId: 'e1', key: k(412), state: 'working', since: START }];
    const c = await t.read();
    assert.equal(c.column, 'running');
    assert.deepEqual(c.sessions.ids, ['e1']);
  });

  test('#507/AC-3 Given Plan sub-issues now exist, Then the card carries plan: { steps: 3 } and no planning state, the run is done', async () => {
    const t = setup();
    await t.runs.save(running({ sessionId: 'p1' }));
    t.sessions.list = [planningSession('p1')];
    t.set([card(412, { subIssues: { total: 3, completed: 0 } })]);
    const c = await t.read();
    assert.deepEqual(c.plan, { steps: 3 });
    assert.equal(c.planning, null);
    assert.equal((await t.runs.get(k(412)))?.outcome, 'done');
  });

  test('a card with no run has planning: null, and existing card fields are unchanged', async () => {
    const t = setup();
    const c = await t.read();
    assert.equal(c.planning, null);
    assert.equal(c.plan, null);
    assert.equal(c.column, 'planning');
  });

  test('without the run store the board works as before', async () => {
    const t = setup(false);
    t.sessions.list = [planningSession('p1')];
    assert.equal((await t.read()).planning, null);
  });
});

describe('#507/AC-4 the card when the planning session ends without a plan', () => {
  test('#507/AC-4 Given the session was seen and is gone and there is no plan, Then the card is back to Planejar with the reason', async () => {
    const t = setup();
    await t.runs.save(running({ sessionId: 'p1' }));
    t.sessions.list = [];
    const c = await t.read();
    assert.equal(c.column, 'planning');
    assert.deepEqual(c.planning, { state: 'failed', reason: 'A sessão de planejamento terminou sem plano' });
    assert.equal(c.plan, null);
    assert.equal((await t.runs.get(k(412)))?.failure, 'session-ended');
  });

  test('#507/AC-4 the failure stays on the card on the next reads, until a new run or a plan', async () => {
    const t = setup();
    await t.runs.save(running({ sessionId: 'p1' }));
    await t.read();
    t.now.add(60 * 60_000);
    assert.equal((await t.read()).planning?.state, 'failed');
    const writes = t.runs.saved.length;
    await t.read();
    assert.equal(t.runs.saved.length, writes, 'a settled run is not written again');
  });

  test('#507/AC-4 Given no session ever appeared within the window, Then the card fails with its own reason', async () => {
    const t = setup();
    await t.runs.save(running());
    assert.deepEqual((await t.read()).planning, { state: 'running' });
    t.now.add(PLAN_SESSION_WINDOW_MS + 1000);
    const c = await t.read();
    assert.equal(c.planning?.state, 'failed');
    assert.match((c.planning as { reason: string }).reason, /não abriu/);
  });

  test('a run for an issue that is not on the board is left as it is', async () => {
    const t = setup();
    await t.runs.save(running({ key: `${REPO}#999` }));
    t.now.add(PLAN_SESSION_WINDOW_MS * 5);
    await t.read();
    assert.equal((await t.runs.get(`${REPO}#999`))?.outcome, 'running');
  });
});
