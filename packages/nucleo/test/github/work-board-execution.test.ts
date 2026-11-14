/*
 * #531 the execution state on the work board: `GET /api/work` puts the card in Em execução with
 * `execution: { state: 'booting' }` until the run's session appears, then links the card to it. The board
 * service counts the cards in Em execução for the route's limit.
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
import { EXECUTION_SESSION_WINDOW_MS, type ExecutionRun, type WorkExecutionRuns } from '../../src/github/work-execution.ts';
import { clock, k, REPO } from './helpers.ts';

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
    subIssues: { total: 2, completed: 0 },
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

class MemoryRuns implements WorkExecutionRuns {
  rows = new Map<string, ExecutionRun>();
  saved: ExecutionRun[] = [];
  async get(key: string) {
    return this.rows.get(key.toLowerCase()) ?? null;
  }
  async all() {
    return [...this.rows.values()];
  }
  async save(run: ExecutionRun) {
    this.rows.set(run.key.toLowerCase(), run);
    this.saved.push(run);
  }
}

const history: WorkColumnHistory = { observe: async (os) => new Map(os.map((o) => [o.key, o.at])) };

function setup(items: ProjectCard[] = [card(412)], withRuns = true) {
  const now = clock();
  const current = projectOf(items);
  const sessions = { list: [] as WorkSessionLink[] };
  const runs = new MemoryRuns();
  const project: WorkProjectBoard = { board: async () => current };
  const live: WorkSessions = { links: async () => sessions.list };
  const service = new WorkBoardService({ project, sessions: live, queue: EMPTY_WORK_QUEUE, history, now, ...(withRuns ? { executionRuns: runs } : {}) });
  const read = async (n = 412): Promise<WorkBoardCard> => (await service.board({ ...DEFAULT_WORK_BOARD_FILTERS })).columns.flatMap((c) => c.cards).find((c) => c.number === n)!;
  return { now, runs, sessions, service, read };
}

const booting = (over: Partial<ExecutionRun> = {}): ExecutionRun => ({ key: k(412), target: 'terminal', startedAt: START, state: 'booting', sessionId: null, finishedAt: null, ...over });
const execSession = (id: string, over: Partial<WorkSessionLink> = {}): WorkSessionLink => ({ sessionId: id, key: k(412), state: 'working', since: '2026-10-18T12:00:05.000Z', execution: true, ...over });

describe('#531/AC-2 the card while its execution session boots', () => {
  test('#531/AC-2 Given a run and no session yet, Then the card is in running with the boot state and no session', async () => {
    const t = setup();
    await t.runs.save(booting());
    const c = await t.read();
    assert.equal(c.column, 'running');
    assert.deepEqual(c.execution, { state: 'booting' });
    assert.deepEqual(c.sessions, { count: 0, state: null, ids: [] });
  });

  test('#531/AC-2 Given the run\'s session is live, Then the card is linked to it, the boot state clears and the run remembers the session', async () => {
    const t = setup();
    await t.runs.save(booting());
    t.sessions.list = [execSession('e1')];
    const c = await t.read();
    assert.equal(c.column, 'running');
    assert.equal(c.execution, null);
    assert.deepEqual(c.sessions, { count: 1, state: 'working', ids: ['e1'] });
    assert.equal((await t.runs.get(k(412)))?.sessionId, 'e1');
    assert.equal((await t.runs.get(k(412)))?.state, 'linked');
  });

  test('#531/AC-2 Given no session within the window, Then the run expires and the card goes back to where it was', async () => {
    const t = setup();
    await t.runs.save(booting());
    assert.equal((await t.read()).column, 'running');
    t.now.add(EXECUTION_SESSION_WINDOW_MS + 1000);
    const c = await t.read();
    assert.equal(c.column, 'planning');
    assert.equal(c.execution, null);
    assert.equal((await t.runs.get(k(412)))?.state, 'expired');
  });

  test('#531/AC-2 a planning session of the issue is not the execution session', async () => {
    const t = setup();
    await t.runs.save(booting());
    t.sessions.list = [{ sessionId: 'p1', key: k(412), state: 'working', since: '2026-10-18T12:00:05.000Z', planning: true }];
    const c = await t.read();
    assert.deepEqual(c.execution, { state: 'booting' });
    assert.equal((await t.runs.get(k(412)))?.sessionId, null);
  });

  test('a card with no run has execution: null, and without the run store the board works as before', async () => {
    assert.equal((await setup().read()).execution, null);
    const t = setup([card(412)], false);
    assert.equal((await t.read()).execution, null);
  });

  test('a settled run is not written again', async () => {
    const t = setup();
    await t.runs.save(booting());
    t.sessions.list = [execSession('e1')];
    await t.read();
    const writes = t.runs.saved.length;
    await t.read();
    assert.equal(t.runs.saved.length, writes);
  });
});

describe('#531/AC-3 the running count', () => {
  test('#531/AC-3 Given one card with a live working session and one booting run, Then the service counts 2 cards in running', async () => {
    const t = setup([card(412), card(413), card(414)]);
    await t.runs.save(booting());
    t.sessions.list = [{ sessionId: 'w', key: k(413), state: 'working', since: START }];
    assert.equal(await t.service.runningCount(), 2);
  });

  test('#531/AC-3 with nothing running the count is 0', async () => {
    assert.equal(await setup().service.runningCount(), 0);
  });
});
